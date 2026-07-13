import type { AssetClass, Tier } from './constants';

// 등급 산정 — 전적으로 '점수'에 의해 결정된다 (경쟁적 요소).
// 점수 산정 규칙은 scoring.ts. 시즌제 재산정 시 같은 임계값으로 전면 재평가(강등 포함).
// 임계값 수치는 초안 — 시뮬레이션으로 확정 예정 (CLAUDE.md 6.5절).
// 챌린저는 상대평가(플래티넘 상위 5%)라 개별 임계값이 없으며 MVP 범위에서 제외.

export type TierThresholds = Record<Exclude<Tier, 'BRONZE' | 'CHALLENGER'>, number>;

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  SILVER: 1_000,
  GOLD: 3_000,
  PLATINUM: 8_000,
};

/**
 * 누적 점수로 등급을 계산한다. 조건을 만족하는 최상위 등급을 반환하며,
 * 기존 등급보다 낮으면 강등이다 (강등 시 기존 구독자 유지, 신규 판매만 제한 — 판매 레이어에서 처리).
 */
export function evaluateTier(
  totalScore: number,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): Exclude<Tier, 'CHALLENGER'> {
  if (totalScore >= thresholds.PLATINUM) return 'PLATINUM';
  if (totalScore >= thresholds.GOLD) return 'GOLD';
  if (totalScore >= thresholds.SILVER) return 'SILVER';
  return 'BRONZE';
}

/**
 * 자산군별 분리 집계에서의 등급 (확정 규칙, CLAUDE.md §2.2):
 * 점수·리더보드는 자산군별로 경쟁하고, 등급은 자산군별 누적 점수 중 최고값 하나로 정한다.
 * (자산군 간 변동성 격차 때문에 합산하면 코인 점수가 주식 점수를 지배하는 왜곡 발생)
 */
export function evaluateTierAcrossAssetClasses(
  scoresByAssetClass: Partial<Record<AssetClass, number>>,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): Exclude<Tier, 'CHALLENGER'> {
  const scores = Object.values(scoresByAssetClass);
  const best = scores.length > 0 ? Math.max(...scores) : 0;
  return evaluateTier(best, thresholds);
}
