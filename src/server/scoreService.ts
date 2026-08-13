import type { PrismaClient } from '@prisma/client';
import { ASSET_CLASSES, type AssetClass } from '@/domain/constants';

// 점수 집계: Judgment.score를 시즌·자산군별로 합산한다.
// 등급(§3.1)과 마이너스 규율(§2.2)의 입력이 된다. 시즌 = 분기 (KST 기준).

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

/** 기준 시각이 속한 시즌의 자산군별 누적 점수 (판정 시각 기준 집계) */
export async function researcherSeasonScores(
  prisma: PrismaClient,
  researcherId: string,
  at = new Date(),
): Promise<Record<AssetClass, number>> {
  return (await researcherSeasonTotals(prisma, researcherId, at)).score;
}

/**
 * 기준 시각이 속한 시즌의 자산군별 **점수와 정보량**.
 *
 * 둘을 함께 내는 이유: 쓰는 곳이 다르다. 등급·리더보드는 점수(수익성 가중 포함)를 보고,
 * 규율 래더는 정보량(가중 없는 로그우도비)을 본다 — 증거는 목표 크기에 비례하지 않는다.
 * 한 번의 조회로 둘 다 내야 두 값이 서로 다른 시점의 데이터를 보는 일이 없다.
 */
export async function researcherSeasonTotals(
  prisma: PrismaClient,
  researcherId: string,
  at = new Date(),
): Promise<{ score: Record<AssetClass, number>; evidence: Record<AssetClass, number> }> {
  const judgments = await prisma.judgment.findMany({
    where: {
      judgedAt: { gte: seasonStart(at), lt: nextSeasonStart(at) },
      score: { not: null },
      predictionCard: { report: { researcherId } },
    },
    select: { score: true, info: true, predictionCard: { select: { assetClass: true } } },
  });

  const zero = () =>
    Object.fromEntries(ASSET_CLASSES.map((a) => [a, 0])) as Record<AssetClass, number>;
  const score = zero();
  const evidence = zero();
  for (const j of judgments) {
    const a = j.predictionCard.assetClass as AssetClass;
    score[a] += j.score!;
    // info는 v5 이전 판정에 없다(null) — 그 카드는 증거로 세지 않는다.
    // 규율이 옛 데이터로 소급 발동하지 않는 편이 안전하다(불리한 처분은 소급하지 않는다)
    evidence[a] += j.info ?? 0;
  }
  return { score, evidence };
}
