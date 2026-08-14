import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, Outcome } from '@/domain/constants';
import { computeTrackRecord, type JudgedPrediction } from '@/domain/trackRecord';
import { DISPUTE_WINDOW_DAYS } from './judgmentDisputeService';
import { seasonStart, nextSeasonStart } from './scoreService';

// 리더보드·공개 프로필용 집계 (읽기 전용).
// 리더보드는 자산군별로 분리 (§2.2 확정) — assetClass로 필터한다.

interface JudgmentRow {
  score: number | null;
  outcome: string;
  settledPrice: number | null;
  judgedAt: Date;
  predictionCard: {
    assetClass: string;
    direction: string;
    basePrice: number | null;
  };
}

function toJudgedPrediction(j: JudgmentRow): JudgedPrediction {
  return {
    outcome: j.outcome as Outcome,
    direction: j.predictionCard.direction as Direction,
    basePrice: j.predictionCard.basePrice ?? 0,
    settledPrice: j.settledPrice ?? undefined,
    judgedAt: j.judgedAt,
  };
}

export interface LeaderboardEntry {
  researcherId: string;
  name: string;
  tier: string;
  careerBadge: string | null;
  seasonScore: number;
  hitRate: number | null;
  sampleSize: number;
  verifying: boolean;
  hypotheticalReturnPct: number | null;
}

/** 판정 이력이 있는 종목 목록 — 종목별 리더보드 필터용 (판정 많은 순) */
export async function getJudgedInstruments(
  prisma: PrismaClient,
  assetClass: AssetClass,
): Promise<{ ticker: string; assetName: string; judgedCount: number }[]> {
  const cards = await prisma.predictionCard.findMany({
    where: { assetClass, judgment: { isNot: null } },
    select: { ticker: true, assetName: true },
  });

  const byTicker = new Map<string, { ticker: string; assetName: string; judgedCount: number }>();
  for (const c of cards) {
    const row = byTicker.get(c.ticker);
    if (row) row.judgedCount++;
    else byTicker.set(c.ticker, { ticker: c.ticker, assetName: c.assetName, judgedCount: 1 });
  }

  return [...byTicker.values()].sort(
    (a, b) => b.judgedCount - a.judgedCount || a.assetName.localeCompare(b.assetName, 'ko'),
  );
}

/**
 * 자산군별 리더보드 — 현재 시즌 점수 기준 내림차순.
 * ticker를 주면 그 종목의 판정만으로 집계한다(종목별 리더보드).
 */
export async function getLeaderboard(
  prisma: PrismaClient,
  assetClass: AssetClass,
  now = new Date(),
  ticker?: string,
): Promise<LeaderboardEntry[]> {
  // 판정에서 출발해 해당 자산군(·종목)만 조회 — 전체 리서처×리포트 풀스캔 회피
  const judgments = await prisma.judgment.findMany({
    where: { predictionCard: ticker ? { assetClass, ticker } : { assetClass } },
    select: {
      score: true,
      outcome: true,
      settledPrice: true,
      judgedAt: true,
      predictionCard: {
        select: {
          assetClass: true,
          direction: true,
          basePrice: true,
          report: { select: { researcherId: true } },
        },
      },
    },
  });
  if (judgments.length === 0) return [];

  const byResearcher = new Map<string, typeof judgments>();
  for (const j of judgments) {
    const rid = j.predictionCard.report.researcherId;
    const list = byResearcher.get(rid);
    if (list) list.push(j);
    else byResearcher.set(rid, [j]);
  }

  const profiles = await prisma.researcherProfile.findMany({
    where: { id: { in: [...byResearcher.keys()] } },
    include: { user: { select: { penName: true, email: true } } },
  });

  const seasonLo = seasonStart(now);
  const seasonHi = nextSeasonStart(now);

  const entries = profiles.map((p) => {
    const js = byResearcher.get(p.id) ?? [];
    const seasonScore = js
      .filter((j) => j.judgedAt >= seasonLo && j.judgedAt < seasonHi)
      .reduce((acc, j) => acc + (j.score ?? 0), 0);

    const record = computeTrackRecord(js.map(toJudgedPrediction), now);
    return {
      researcherId: p.id,
      name: p.user.penName ?? p.user.email,
      tier: p.tier,
      careerBadge: p.careerBadge,
      seasonScore,
      hitRate: record.hitRate,
      sampleSize: record.sampleSize,
      verifying: record.verifying,
      hypotheticalReturnPct: record.hypotheticalReturnPct,
    };
  });

  // 판정 표본이 있는 리서처만 노출, 시즌 점수 내림차순
  return entries
    .filter((e) => e.sampleSize > 0)
    .sort((a, b) => b.seasonScore - a.seasonScore);
}

export interface RankingEntry {
  researcherId: string;
  name: string;
  tier: string;
  careerBadge: string | null;
  /** 전체 기간·전 자산군 누적 점수 (리더보드의 시즌 점수와 다르다) */
  totalScore: number;
  hitRate: number | null;
  sampleSize: number;
  verifying: boolean;
  hypotheticalReturnPct: number | null;
}

export type RankingSort = 'SCORE' | 'HIT_RATE' | 'RETURN';

/**
 * 표본 미달자는 **어느 기준에서도 뒤로 보낸다** (2026-08-15).
 *
 * 예전에는 점수 정렬에서만 빼 줬다. 그 구멍이 **양방향 베팅**의 착지점이다 —
 * 계정 둘로 같은 종목에 상승·하락을 걸면 하나는 반드시 적중하고, 진 계정은 버린다.
 * 구매자는 실패 시 전액 환불이라 항의하지 않으므로 어뷰저가 치르는 값이 거의 없다.
 * 목적은 환불금이 아니라 **"적중률 100%"라는 화면**이고, 그 화면이 가장 잘 팔리는
 * 자리가 랭킹 상단이다.
 *
 * **탐지로는 못 막는다** — 같은 종목에 반대 방향 카드가 걸리는 것은 정상적인 시장
 * 의견 차이와 구별되지 않는다. 그래서 탐지 대신 **값어치를 없앤다**: 표본이 찰 때까지
 * 상단에 못 올라가면, 계정을 새로 파는 방식으로는 "검증 중" 딱지를 뗄 수 없다.
 * 점수 정렬도 예외가 아닌 이유는 vmax 점수가 카드당 유계여서 1~2장으로는 상단에
 * 못 가지만, **표본 10장 미만끼리의 순위**는 여전히 어뷰저에게 유리하기 때문이다.
 *
 * ⚠ **목록에서 빼지는 않는다.** 신규 리서처가 아예 안 보이면 콜드스타트가 죽는다 —
 * 이 서비스가 가장 두려워하는 실패다(§5 핵심 리스크 1). 순서만 뒤로 미룬다.
 */
function sortRanking(entries: RankingEntry[], sort: RankingSort): RankingEntry[] {
  const num = (v: number | null) => (v === null ? -Infinity : v);
  return [...entries].sort((a, b) => {
    if (a.verifying !== b.verifying) return a.verifying ? 1 : -1;
    if (sort === 'HIT_RATE') return num(b.hitRate) - num(a.hitRate);
    if (sort === 'RETURN') return num(b.hypotheticalReturnPct) - num(a.hypotheticalReturnPct);
    return b.totalScore - a.totalScore;
  });
}

/**
 * 전체 랭킹 — 전 기간·전 자산군 통합.
 * 리더보드(getLeaderboard)가 "이번 시즌 × 자산군별"이라면 이쪽은 누적 트랙레코드다.
 */
export async function getAllTimeRanking(
  prisma: PrismaClient,
  sort: RankingSort = 'SCORE',
  now = new Date(),
): Promise<RankingEntry[]> {
  const judgments = await prisma.judgment.findMany({
    select: {
      score: true,
      outcome: true,
      settledPrice: true,
      judgedAt: true,
      predictionCard: {
        select: {
          assetClass: true,
          direction: true,
          basePrice: true,
          report: { select: { researcherId: true } },
        },
      },
    },
  });
  if (judgments.length === 0) return [];

  const byResearcher = new Map<string, typeof judgments>();
  for (const j of judgments) {
    const rid = j.predictionCard.report.researcherId;
    const list = byResearcher.get(rid);
    if (list) list.push(j);
    else byResearcher.set(rid, [j]);
  }

  const profiles = await prisma.researcherProfile.findMany({
    where: { id: { in: [...byResearcher.keys()] } },
    include: { user: { select: { penName: true, email: true } } },
  });

  const entries = profiles
    .map((p) => {
      const js = byResearcher.get(p.id) ?? [];
      const record = computeTrackRecord(js.map(toJudgedPrediction), now);
      return {
        researcherId: p.id,
        name: p.user.penName ?? p.user.email,
        tier: p.tier,
        careerBadge: p.careerBadge,
        totalScore: js.reduce((acc, j) => acc + (j.score ?? 0), 0),
        hitRate: record.hitRate,
        sampleSize: record.sampleSize,
        verifying: record.verifying,
        hypotheticalReturnPct: record.hypotheticalReturnPct,
      };
    })
    .filter((e) => e.sampleSize > 0);

  return sortRanking(entries, sort);
}

/** 공개 프로필: 자산군별 트랙레코드 + 판매 중 리포트 + 판정 이력 */
export async function getPublicProfile(
  prisma: PrismaClient,
  researcherId: string,
  now = new Date(),
) {
  const profile = await prisma.researcherProfile.findUnique({
    where: { id: researcherId },
    include: {
      user: { select: { penName: true, email: true } },
      reports: {
        orderBy: { publishedAt: 'desc' },
        include: { predictionCard: { include: { judgment: true } } },
      },
    },
  });
  if (!profile) return null;

  const judgedCards = profile.reports
    .map((r) => r.predictionCard)
    .filter((c) => c?.judgment) as Array<
    NonNullable<(typeof profile.reports)[number]['predictionCard']>
  >;

  // 자산군별 트랙레코드
  const byAsset = new Map<AssetClass, JudgedPrediction[]>();
  for (const c of judgedCards) {
    const list = byAsset.get(c.assetClass as AssetClass) ?? [];
    list.push({
      outcome: c.judgment!.outcome as Outcome,
      direction: c.direction as Direction,
      basePrice: c.basePrice ?? 0,
      settledPrice: c.judgment!.settledPrice ?? undefined,
      judgedAt: c.judgment!.judgedAt,
    });
    byAsset.set(c.assetClass as AssetClass, list);
  }
  const trackRecords = [...byAsset.entries()].map(([assetClass, preds]) => ({
    assetClass,
    ...computeTrackRecord(preds, now),
  }));

  const buyable = profile.reports.filter((r) => r.status === 'PUBLISHED');
  const history = profile.reports.filter((r) => r.predictionCard?.judgment);

  return { profile, trackRecords, buyable, history };
}

/** 리포트 상세 + 뷰어의 구매 여부 */
export async function getReportDetail(
  prisma: PrismaClient,
  reportId: string,
  viewerUserId: string | null,
  now = new Date(),
) {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    include: {
      predictionCard: { include: { judgment: true } },
      researcher: { include: { user: { select: { id: true, penName: true, email: true } } } },
    },
  });
  if (!report) return null;

  // **열람 권한은 구매 행의 존재가 아니라 상태가 정한다.**
  //
  // 판정 실패로 환불(REFUNDED)된 구매자는 본문을 계속 본다 — 읽고 결과를 기다린,
  // 약속대로 끝난 거래다. 반면 CS 환불(CANCELLED)은 **거래 자체의 무효화**라
  // "산 적 없는 것"이 되어야 한다. 같은 값을 썼다면 결제 → 열람 → 즉시 CS환불이
  // 공짜 열람 경로가 됐을 것이다(purchaseVoidService).
  const purchase = viewerUserId
    ? await prisma.purchase.findFirst({
        where: { reportId, buyerId: viewerUserId, escrowStatus: { not: 'CANCELLED' } },
        // 환불 시도까지 — 구매자 화면이 "확정됐지만 아직 안 보냄"과 "보내는 중"을
        // 구별하려면 필요하다. 그 구별이 없으면 며칠짜리 대기가 방치로 읽힌다
        include: {
          settlement: { include: { refundAttempts: true } },
          // 이미 이의를 냈는지 — 화면이 접수 양식 대신 "검토 중"을 보여줘야 한다
          judgmentDispute: { select: { id: true, status: true } },
        },
      })
    : null;

  // 종목의 현재 위험 등급 — 게시 시점이 아니라 지금 값을 보여준다.
  // 게시 후 경고 지정된 종목이라면 구매자는 그 사실을 알고 사야 한다.
  const instrument = report.predictionCard
    ? await prisma.instrument.findUnique({
        where: {
          assetClass_ticker: {
            assetClass: report.predictionCard.assetClass,
            ticker: report.predictionCard.ticker,
          },
        },
        select: { riskLevel: true, riskNote: true },
      })
    : null;

  // **이의제기 창이 열려 있나 — 판단은 여기서 한다.**
  // 화면에서 `Date.now()`를 부르면 렌더가 순수하지 않고(같은 입력에 다른 결과),
  // 무엇보다 "며칠까지 받을 것인가"는 화면의 취향이 아니라 **서비스의 규칙**이다
  const judgedAt = report.predictionCard?.judgment?.judgedAt;
  const disputable =
    !!purchase &&
    !!judgedAt &&
    !purchase.judgmentDispute &&
    (now.getTime() - judgedAt.getTime()) / 86_400_000 <= DISPUTE_WINDOW_DAYS;

  return { report, purchase, instrument, disputable };
}
