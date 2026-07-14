import type { PrismaClient } from '@prisma/client';
import { TIERS, type Tier } from '@/domain/constants';
import { evaluateTierAcrossAssetClasses } from '@/domain/tiers';
import { researcherSeasonScores, seasonOf, seasonStart } from './scoreService';

// 시즌(분기) 재산정: 직전 시즌 점수로 전 리서처 등급을 전면 재평가한다 (§3.1).
// - 승급·강등 모두 같은 임계값 — 점수 미달이면 강등
// - 변경은 TierHistory에 기록 (감사·프로필 이력 표시)
// - 챌린저(상대평가)는 MVP 제외 — 재산정 대상에서 건너뛴다
// - 마이너스 규율의 "게시 정지(시즌 종료까지)"는 별도 처리 불필요: 점수 집계가
//   시즌 단위라 새 시즌이 열리면 점수 0에서 시작 → 규율 자동 해제
// 실행 시점: 분기 첫날 (1/4/7/10월 1일 00:10 KST 크론) — npm run batch:season

export interface SeasonRecalcSummary {
  season: string;
  evaluated: number;
  promoted: number;
  demoted: number;
  unchanged: number;
}

const TIER_ORDER: Record<Tier, number> = Object.fromEntries(
  TIERS.map((t, i) => [t, i]),
) as Record<Tier, number>;

export async function recalcSeasonTiers(
  prisma: PrismaClient,
  now = new Date(),
): Promise<SeasonRecalcSummary> {
  // 직전 시즌의 마지막 순간 — 그 시즌의 점수로 평가한다
  const prevSeasonMoment = new Date(seasonStart(now).getTime() - 1);
  const season = seasonOf(prevSeasonMoment);

  const profiles = await prisma.researcherProfile.findMany();
  const summary: SeasonRecalcSummary = {
    season,
    evaluated: 0,
    promoted: 0,
    demoted: 0,
    unchanged: 0,
  };

  for (const profile of profiles) {
    if (profile.tier === 'CHALLENGER') continue; // 상대평가 — MVP 제외

    const scores = await researcherSeasonScores(prisma, profile.id, prevSeasonMoment);
    const newTier = evaluateTierAcrossAssetClasses(scores);
    summary.evaluated++;

    if (newTier === profile.tier) {
      summary.unchanged++;
      continue;
    }

    const promotion = TIER_ORDER[newTier] > TIER_ORDER[profile.tier as Tier];
    await prisma.$transaction([
      prisma.researcherProfile.update({
        where: { id: profile.id },
        data: { tier: newTier },
      }),
      prisma.tierHistory.create({
        data: {
          researcherId: profile.id,
          season,
          fromTier: profile.tier,
          toTier: newTier,
          reason: promotion ? 'PROMOTION' : 'DEMOTION',
        },
      }),
    ]);
    if (promotion) summary.promoted++;
    else summary.demoted++;
  }

  return summary;
}
