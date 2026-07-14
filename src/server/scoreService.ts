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
  const judgments = await prisma.judgment.findMany({
    where: {
      judgedAt: { gte: seasonStart(at), lt: nextSeasonStart(at) },
      score: { not: null },
      predictionCard: { report: { researcherId } },
    },
    select: { score: true, predictionCard: { select: { assetClass: true } } },
  });

  const scores = Object.fromEntries(ASSET_CLASSES.map((a) => [a, 0])) as Record<
    AssetClass,
    number
  >;
  for (const j of judgments) {
    scores[j.predictionCard.assetClass as AssetClass] += j.score!;
  }
  return scores;
}
