import type { AssetClass, Tier } from './constants';

// 등급 산정 — 전적으로 '점수'에 의해 결정된다 (경쟁적 요소).
// 점수 산정 규칙은 scoring.ts. 시즌제 재산정 시 같은 임계값으로 전면 재평가(강등 포함).
// 임계값 수치는 초안 — 시뮬레이션으로 확정 예정 (CLAUDE.md 6.5절).
// 인투빌 펠로우는 상대평가(펠로우 상위 5%)라 개별 임계값이 없으며 MVP 범위에서 제외.

export type TierThresholds = Record<Exclude<Tier, 'BRONZE' | 'CHALLENGER'>, number>;

// 시뮬레이션 근거 (scripts/simTierThresholds.ts — 점수 v4 재캘리브레이션, 2026-08-12):
// - 목표 피라미드 "절반 사다리" 유지: 시니어 상위 ~50% / 마스터 ~25% / 펠로우 ~10%
//   (인투빌 펠로우 ~1%는 점수 임계값이 아닌 심사·상대평가 — MVP 제외 유지)
// - v4(공정배당 이항)는 점수 스케일이 v3와 다르다: 어려운 목표의 적중이 (1−p₀) 가중으로
//   크게 지급되어 상위 실력의 시즌 점수가 v3보다 훨씬 크다 → 임계값 전면 상향
// - 모집단 가정: 정밀 5%/우수 25%/준수 50%/하위 15%/스팸 5% (v3와 동일 구성),
//   실력 = 일 드리프트 k·σ(0.5/0.35/0.2/0.08/0), 행동 = 각자 EV 최적 (M, c)
//   — v4는 정직 신고가 곧 EV 최적이라 v3의 "정직 신고" 가정과 같은 뜻이다
// - 시즌 20장 실측: 시니어 58.7% / 마스터 26.1% / 펠로우 13.3% 도달,
//   준수형 시니어 도달 58% (v3 54%와 비슷 — 콜드스타트 이탈 방지 유지)
// - ⚠ 시즌 장수 민감도가 v3보다 크다 (12장: 마스터 12.8%·펠로우 3.2% / 30장: 펠로우 23.9%)
//   — 코호트 간 카드당 EV 격차가 커서다. 운영 데이터로 재조정 전제
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  SILVER: 3_500,
  GOLD: 14_500,
  PLATINUM: 23_000,
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
