import type { AssetClass, Tier } from './constants';

// 등급 산정 — 전적으로 '점수'에 의해 결정된다 (경쟁적 요소).
// 점수 산정 규칙은 scoring.ts. 시즌제 재산정 시 같은 임계값으로 전면 재평가(강등 포함).
// 임계값 수치는 초안 — 시뮬레이션으로 확정 예정 (CLAUDE.md 6.5절).
// 인투빌 펠로우는 상대평가(펠로우 상위 5%)라 개별 임계값이 없으며 MVP 범위에서 제외.

export type TierThresholds = Record<Exclude<Tier, 'BRONZE' | 'CHALLENGER'>, number>;

// 시뮬레이션 근거 (scripts/simTierThresholds.ts — 점수 v3 재캘리브레이션, 2026-08-05):
// - 목표 피라미드 "절반 사다리": 시니어 상위 50% / 마스터 상위 25% / 펠로우 상위 10%
//   (인투빌 펠로우 ~1%는 점수 임계값이 아닌 심사·상대평가 — MVP 제외 유지)
// - 시니어 50%: 준수한 리서처 절반이 첫 시즌 도달(실측 54%) — 콜드스타트 이탈 방지.
//   특권이 수수료 인하뿐이라 수익성 비용 최소
// - 마스터 25%: 선결제 해금 경계 — 구매자 무위험 진입(100% 성과 연동)을 전체의 75%로 유지
// - 펠로우 10%: 구독(2단계 매출) 공급자를 초기 30~50명 기준 3~5명 확보
// - 모집단 가정: 정밀 5%/우수 25%/준수 50%/하위 15%/스팸 5%, 시즌 20장 (12~30장 민감도 확인)
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  SILVER: 300,
  GOLD: 900,
  PLATINUM: 2_400,
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
