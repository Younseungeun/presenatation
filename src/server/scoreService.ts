import type { PrismaClient } from '@prisma/client';
import { ASSET_CLASSES, type AssetClass, type Tier } from '@/domain/constants';
import { evaluateTierAcrossAssetClasses } from '@/domain/tiers';

// 점수 집계: Judgment.score를 시즌·자산군별로 합산한다.
// 등급(§3.1)과 마이너스 규율(§2.2)의 입력이 된다. 시즌 = 분기 (KST 기준).

/** 예: 2026-07-13 → "2026-Q3" */
export function seasonOf(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 3600_000);
  return `${kst.getUTCFullYear()}-Q${Math.floor(kst.getUTCMonth() / 3) + 1}`;
}

/** 시즌 시작 시각 (KST 분기 첫날 00:00 = UTC 전일 15:00) */
export function seasonStart(d: Date): Date {
  const kst = new Date(d.getTime() + 9 * 3600_000);
  const quarterMonth = Math.floor(kst.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(kst.getUTCFullYear(), quarterMonth, 1) - 9 * 3600_000);
}

/** 리서처의 현재 시즌 자산군별 누적 점수 */
export async function researcherSeasonScores(
  prisma: PrismaClient,
  researcherId: string,
  now = new Date(),
): Promise<Record<AssetClass, number>> {
  const judgments = await prisma.judgment.findMany({
    where: {
      judgedAt: { gte: seasonStart(now) },
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

/** 시즌 점수로 등급 산정 (자산군별 최고값 — §2.2 확정 규칙) */
export async function evaluateResearcherTier(
  prisma: PrismaClient,
  researcherId: string,
  now = new Date(),
): Promise<Exclude<Tier, 'CHALLENGER'>> {
  const scores = await researcherSeasonScores(prisma, researcherId, now);
  return evaluateTierAcrossAssetClasses(scores);
}
