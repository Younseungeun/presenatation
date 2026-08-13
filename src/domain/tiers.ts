import type { AssetClass, Tier } from './constants';

// 등급 산정 — 전적으로 '점수'에 의해 결정된다 (경쟁적 요소).
// 점수 산정 규칙은 scoring.ts. 시즌제 재산정 시 같은 임계값으로 전면 재평가(강등 포함).
// 임계값 수치는 초안 — 시뮬레이션으로 확정 예정 (CLAUDE.md 6.5절).
// 인투빌 펠로우는 상대평가(펠로우 상위 5%)라 개별 임계값이 없으며 MVP 범위에서 제외.

export type TierThresholds = Record<Exclude<Tier, 'BRONZE' | 'CHALLENGER'>, number>;

// 시뮬레이션 근거 (scripts/simSkillSeparation.ts — 점수 v5 재캘리브레이션, 2026-08-13):
//
// 점수 모델이 v4(공정배당 이항) → v5(정보량 로그 점수)로 바뀌며 눈금이 통째로
// 달라졌다. 옛 임계값(3,500 / 14,500 / 23,000)은 그 전의 눈금이라 아무것도 뜻하지
// 않게 됐다 — **목표 피라미드는 그대로 두고 새 점수 분포의 50/75/90분위로 다시 잡는다.**
//   · 목표 "절반 사다리": 시니어 상위 ~50% / 마스터 ~25% / 펠로우 ~10%
//     (인투빌 펠로우 ~1%는 점수 임계값이 아닌 심사·상대평가 — MVP 제외 유지)
//   · 모집단 가정: 정밀 5%/우수 25%/준수 50%/하위 15%/스팸 5%,
//     실력 = 일 드리프트 k·σ(0.5/0.35/0.2/0.08/0), 행동 = 각자 EV 최적 (M, c)
//     — v5는 적정 점수법이라 EV 최적이 곧 "정직하게 신고한다"와 같은 뜻이다
//
// 같은 시뮬이 분리력도 함께 쟀다 (등급이 실력을 가르는지는 피라미드 모양이 말해주지 않는다):
//   · **오분류 0%** — 스팸이 시니어에 오르지도, 정밀이 시니어에 못 오르지도 않는다
//   · AUC  스팸<준수 0.961 / 하위<준수 0.940 / 준수<우수 0.936 / 우수<정밀 0.979
//     (v4 대비: 하위<준수 0.785 → 0.940, 스팸<준수 0.819 → 0.961)
//   · 순위상관(실력↔점수) 0.835 (v4 0.792)
//   · 도달률: 준수 48% 시니어 / 우수 78% 마스터 / 정밀 98% 펠로우
//   · 결정적으로 **꼬리가 겹치지 않는다** — 준수형 p5 +177 vs 스팸 p95 −30
//     (v4는 −3,354 vs −189로 뒤집혀 있었다. 그래서 규율이 실력자를 벌했다)
//
// 시즌 장수 민감도는 v4보다 낮다 — 카드당 점수가 유계라 누적 분산이 작다.
// 그래도 운영 데이터로 모집단·게시량 가정을 재조정하는 것은 전제다.
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  SILVER: 1_330,
  GOLD: 2_770,
  PLATINUM: 5_250,
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
