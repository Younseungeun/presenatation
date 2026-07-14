import type { AssetClass, Tier } from './constants';

// 등급 산정 — 전적으로 '점수'에 의해 결정된다 (경쟁적 요소).
// 점수 산정 규칙은 scoring.ts. 시즌제 재산정 시 같은 임계값으로 전면 재평가(강등 포함).
// 임계값 수치는 초안 — 시뮬레이션으로 확정 예정 (CLAUDE.md 6.5절).
// 챌린저는 상대평가(플래티넘 상위 5%)라 개별 임계값이 없으며 MVP 범위에서 제외.

export type TierThresholds = Record<Exclude<Tier, 'BRONZE' | 'CHALLENGER'>, number>;

// 시뮬레이션 근거 (docs/tier-thresholds-sim.md):
// - 분포 피라미드: 브론즈 59% / 실버 30% / 골드 9% / 플래티넘 2% (신호 가치 유지)
// - 준수한 리서처(승률 65~72%)의 절반이 첫 시즌에 실버 도달 (승급 동기 — 이탈 방지)
// - 플래티넘 2%면 초기 30~50명 중 1명 안팎 — 구독 상품(2단계 매출) 해금 가능
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  SILVER: 600,
  GOLD: 2_000,
  PLATINUM: 5_000,
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
