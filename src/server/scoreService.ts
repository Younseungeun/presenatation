import type { PrismaClient } from '@prisma/client';
import { ASSET_CLASSES, type AssetClass, type Direction } from '@/domain/constants';
import { aggregateEvidence, type EvidenceCard } from '@/domain/evidence';
import { disciplineFor } from '@/domain/scoring';

// 점수 집계: Judgment.score를 시즌·자산군별로 합산한다. 시즌 = 분기 (KST 기준).
//
// **점수와 규율 증거는 집계 방법도, 기간도 다르다.**
//  · 점수(등급·리더보드의 입력)는 **시즌 단순 합산**이다 — 보상이자 경쟁이라
//    분기마다 새로 시작하는 것이 상품 설계다
//  · 증거(규율 래더의 입력)는 **평생 누적**이고 상관 보정을 거친다 —
//    통계적 검정이라 표본을 버릴 이유가 없다 (아래 researcherSeasonTotals)
//
// ── 증거를 시즌마다 리셋하지 않는 이유 (2026-08-13, scripts/simDisciplineRealtime.ts) ──
// 원래는 증거도 시즌 범위였다. 그런데 상관 보정을 넣은 뒤 한 시즌의 **유효 장수가
// 2.6장**이 됐다 — 20장을 내도 겹친 기간만큼 하중이 나뉘고, 기한 30일 카드는 시즌
// 91일 중 61일 이후 게시분이 다음 시즌에 판정되어 14장만 남는다. 그 크기로는
// 아무것도 결정할 수 없어서 **래더가 한 번도 발동하지 못했다** (표적 발동 0.0%,
// 실력 없이 ★4+로 팔린 카드가 규율 없을 때와 같은 0.90장/인).
//
// 창을 늘리면 되살아난다 (게시 간격 고정, 20장당 피해로 환산):
//
//   증거 창      유효 장수   표적 발동   정직한 사람 오작동   ★4+/20장
//   1분기          2.6        0.0%          0.00%            0.84
//   1년           11.6       66.0%          0.14%            0.36
//   2년           23.8       92.0%          0.17%            0.17
//
// **rigor도 함께 좋아진다.** Ville 부등식은 anytime-valid라 창을 늘려도 보장이
// 그대로인 반면, 분기마다 리셋하면 1년에 네 번 독립적으로 문턱을 시험하는 셈이라
// 합집합 상한으로 연간 오작동이 최대 4α가 된다. 리셋하지 않으면 **평생에 걸쳐
// 단 하나의 α**다. 탐지력과 보장을 동시에 개선하는 유일한 방향이었다
// (α 상향도, 하중 완화도 이 문제를 풀지 못했다 — docs/score-discipline-sim.md).
//
// 회복은 여전히 자동이다. D는 현재값의 함수라 적중의 정보량(양수)이 쌓이면
// 문턱에서 멀어진다 — 과거가 지워지는 것이 아니라 상쇄된다.

const KST_OFFSET_MS = 9 * 3600_000;

/** 시각을 KST 벽시계로 환산 (분기 계산용) */
function kstParts(d: Date): { year: number; quarter: number } {
  const kst = new Date(d.getTime() + KST_OFFSET_MS);
  return { year: kst.getUTCFullYear(), quarter: Math.floor(kst.getUTCMonth() / 3) };
}

/** KST 분기 첫날 00:00의 UTC 시각. quarterDelta로 이웃 분기 이동 */
function seasonBoundary(d: Date, quarterDelta = 0): Date {
  const { year, quarter } = kstParts(d);
  return new Date(Date.UTC(year, (quarter + quarterDelta) * 3, 1) - KST_OFFSET_MS);
}

/** 예: 2026-07-13 → "2026-Q3" */
export function seasonOf(d: Date): string {
  const { year, quarter } = kstParts(d);
  return `${year}-Q${quarter + 1}`;
}

/** 시즌 시작 시각 (KST 분기 첫날 00:00 = UTC 전일 15:00) */
export function seasonStart(d: Date): Date {
  return seasonBoundary(d);
}

/** 다음 시즌 시작 시각 */
export function nextSeasonStart(d: Date): Date {
  return seasonBoundary(d, 1);
}

/**
 * 그 자산군에서 지금 쓸 수 있는 **최대 신뢰도** — 규율 래더가 정한다.
 *
 * 게시 관문(preparePublish)뿐 아니라 **구매 관문**도 이 값을 본다. 게시 때만 보면
 * 상한이 내려가기 직전에 낸 ★5 카드가 시한이 끝날 때까지 계속 팔린다 —
 * 장기 카드라면 1년이다. 처분은 신규 게시가 아니라 **판매되는 확신**에 걸려야 한다.
 */
export async function researcherConfidenceCap(
  prisma: PrismaClient,
  researcherId: string,
  assetClass: AssetClass,
  at = new Date(),
): Promise<number> {
  const { evidence } = await researcherSeasonTotals(prisma, researcherId, at);
  return disciplineFor(evidence[assetClass]).maxConfidence;
}

/** 기준 시각이 속한 시즌의 자산군별 누적 점수 (판정 시각 기준 집계) */
export async function researcherSeasonScores(
  prisma: PrismaClient,
  researcherId: string,
  at = new Date(),
): Promise<Record<AssetClass, number>> {
  return (await researcherSeasonTotals(prisma, researcherId, at)).score;
}

/**
 * 자산군별 **시즌 점수**와 **평생 증거**.
 *
 * 둘을 함께 내는 이유: 쓰는 곳이 다르다. 등급·리더보드는 점수(수익성 가중 포함)를 보고,
 * 규율 래더는 정보량(가중 없는 로그우도비)을 본다 — 증거는 목표 크기에 비례하지 않는다.
 * 한 번의 조회로 둘 다 내야 두 값이 서로 다른 시점의 데이터를 보는 일이 없다.
 *
 * **기간이 다르다**: 점수는 `at`이 속한 시즌만, 증거는 그 시즌 끝까지의 전체 이력이다.
 * (`at`을 과거로 주는 재산정에서도 미래 판정이 새어 들어오지 않게 상한을 건다)
 */
export async function researcherSeasonTotals(
  prisma: PrismaClient,
  researcherId: string,
  at = new Date(),
): Promise<{ score: Record<AssetClass, number>; evidence: Record<AssetClass, number> }> {
  const from = seasonStart(at);
  const until = nextSeasonStart(at);
  const judgments = await prisma.judgment.findMany({
    where: {
      judgedAt: { lt: until },
      score: { not: null },
      predictionCard: { report: { researcherId } },
    },
    select: {
      score: true,
      info: true,
      judgedAt: true,
      predictionCard: {
        select: {
          assetClass: true,
          direction: true,
          deadline: true,
          report: { select: { publishedAt: true } },
        },
      },
    },
  });

  const score = Object.fromEntries(ASSET_CLASSES.map((a) => [a, 0])) as Record<AssetClass, number>;
  const cards: EvidenceCard[] = [];
  for (const j of judgments) {
    const a = j.predictionCard.assetClass as AssetClass;
    // 점수는 이번 시즌 판정분만 — 등급은 분기마다 새로 겨룬다
    if (j.judgedAt >= from) score[a] += j.score!;
    // 증거는 기간 제한이 없다 (파일 상단 주석)
    // info는 vmax 이전 판정에 없다(null) — 그 카드는 증거로 세지 않는다.
    // 규율이 옛 데이터로 소급 발동하지 않는 편이 안전하다(불리한 처분은 소급하지 않는다)
    if (j.info == null) continue;
    // **증거가 아닌 카드는 남의 증거를 깎지도 못한다 (2026-08-15).**
    // 판정 불가·철회는 info가 0이라 D에 아무것도 더하지 않는데, 배열에 남으면 겹치는
    // 다른 카드의 **하중은 키운다**(evidence.ts의 j 루프는 info를 보지 않는다).
    // 하중은 상관 보정이고 상관될 정보량이 0인 카드는 아무것도 상관시키지 않는다 —
    // 남겨 두면 순수한 과보정이고, 하필 **취소당한 카드 수만큼 래더가 무뎌지는**
    // 방향이라 "카드를 뿌리고 철회한다"가 규율을 희석하는 경로가 된다
    if (j.info === 0) continue;
    const publishedAt = j.predictionCard.report.publishedAt;
    cards.push({
      assetClass: a,
      direction: j.predictionCard.direction as Direction,
      // 게시 시각이 없으면(이론상 없다) 판정 시각으로 둔다 — 겹침이 안 잡혀
      // 그 카드는 혼자 한 묶음이 된다. 과소 보정이 아니라 그 카드만 온전히 세는 쪽이다
      openedAt: (publishedAt ?? j.judgedAt).getTime(),
      // **닫힌 시각은 배치가 돈 시각이 아니라 결과가 정해진 시각이다 (2026-08-15).**
      //
      // 겹침이 재는 것은 "B를 신고할 때 A의 결과를 알았는가"이고, 리서처는 우리 배치를
      // 기다려 아는 것이 아니다 — 시한의 종가가 찍히는 순간 스스로 계산할 수 있다.
      // judgedAt을 그대로 쓰면 KIS 장애·서버 재부팅·큐 정체가 카드의 "열린 기간"을
      // 늘려 **인프라 사고가 규율 래더의 입력을 바꾼다.** 하루 밀리면 하루만큼 더
      // 겹치고, 겹치면 하중이 커지고, 하중이 커지면 증거가 깎인다.
      //
      // 그렇다고 시한으로 못 박지도 않는다 — **도달 판정**(reachedJudgmentBatch)은
      // 종가가 목표를 넘은 날 결과가 확정되므로 시한보다 훨씬 일찍 닫힌다.
      // 시한으로 고정하면 일찍 이룬 카드가 그 뒤 몇 달을 "열린 채"로 세어진다.
      // 둘을 함께 만족시키는 규칙은 하나다: **더 이른 쪽.**
      //  · 기한 판정 → judgedAt > deadline → 시한 (배치 지연이 지워진다)
      //  · 도달 판정 → judgedAt < deadline → 판정 시각 (실제로 그때 닫혔다)
      // 스키마도 백필도 필요 없다. judgedAt이 시한보다 이른 경우는 도달 판정과
      // 강제 철회뿐이고, 후자는 info가 0이라 위에서 이미 빠진다
      closedAt: Math.min(j.judgedAt.getTime(), j.predictionCard.deadline.getTime()),
      info: j.info,
    });
  }
  // 동시에 열려 있던 같은 자산군·방향 카드는 독립 증거가 아니다 (domain/evidence.ts)
  return { score, evidence: aggregateEvidence(cards) };
}
