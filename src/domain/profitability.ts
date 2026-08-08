import type { AssetClass } from './constants';
import { MIN_MAGNITUDE_PCT, targetPriceToMagnitudePct } from './scoring';

// 수익성 — 리서처가 입력하는 값이 아니라 예측 크기에서 자동 산출되는 표시 지표.
// 구매 전에는 목표 수익률 원값을 가리므로(마스킹), 구매자는 이 5단계로
// "얼마나 공격적인 베팅인가"만 본다. 판정·구매 후에는 원값이 그대로 공개된다.
//
// 경계는 자산군 크기 하한 F(주식 5% / 코인 10%)의 배수 — 주식 10%와 코인 20%가
// 같은 "2×F = LV3"에 놓여 자산군이 달라도 공격성이 같은 축에서 읽힌다.
//
// 경계 1.5/2/3/5는 시뮬레이션으로 확정 (scripts/simProfitabilityBuckets.ts, 2026-08-05):
//  · 변별력: 신고 분포(중앙값 1.6×F) 기준 점유율 45/21/22/11/2% — LV5는 의도된 희소 라벨
//  · 스팸 억제: 무실력자가 라벨만 입는 비용(v3 기대 점수)이 주식 −16→−202,
//    코인 −32→−404점/카드로 가파르게 증가 — 높은 수익성 사칭은 스스로 파멸적
//  · 단타 격리: 실변동이 작은 단타는 하한 신고(LV1)에서도 기대 점수 음수,
//    상위 구간 진입 비용은 무실력자와 동일하게 가파름
//  · 역산 방지: 구간 폭 최소 주식 2.5%p / 코인 5%p — 라벨에서 원값 복원 불가

/** 구간 경계 — F 배수. [1.5, 2, 3, 5] → 5구간 */
export const PROFITABILITY_BOUNDS = [1.5, 2, 3, 5] as const;

export type ProfitabilityLevel = 1 | 2 | 3 | 4 | 5;

export const PROFITABILITY_LABEL: Record<ProfitabilityLevel, string> = {
  1: '소폭',
  2: '보통',
  3: '적극',
  4: '공격',
  5: '초공격',
};

/** 예측 크기(%) → 수익성 레벨 */
export function profitabilityLevel(
  assetClass: AssetClass,
  predictedMagnitudePct: number,
): ProfitabilityLevel {
  const multiple = predictedMagnitudePct / MIN_MAGNITUDE_PCT[assetClass];
  let level = 1;
  for (const bound of PROFITABILITY_BOUNDS) {
    if (multiple >= bound) level++;
  }
  return level as ProfitabilityLevel;
}

export interface ProfitabilityCardInput {
  assetClass: string;
  targetType: string;
  /** RETURN_PCT면 등락률(%), TARGET_PRICE면 목표가 */
  targetValue: number;
  /** 목표가형 환산에 필요. 게시 전(소급 확정 대기)에는 null일 수 있다 */
  basePrice: number | null;
}

/**
 * 카드 → 수익성 레벨. 목표가형인데 기준가가 아직 없으면 null —
 * 목표가형은 게시 시점 기준가 확정(FIXED_AT_PUBLISH)만 허용되므로
 * 게시된 카드에서는 null이 나오지 않는다.
 */
export function cardProfitabilityLevel(card: ProfitabilityCardInput): ProfitabilityLevel | null {
  const magnitude =
    card.targetType === 'RETURN_PCT'
      ? card.targetValue
      : card.basePrice
        ? targetPriceToMagnitudePct(card.targetValue, card.basePrice)
        : null;
  if (magnitude === null) return null;
  return profitabilityLevel(card.assetClass as AssetClass, magnitude);
}

/** 화면용 "수익성 적극" 같은 한 덩어리 라벨 */
export function profitabilityText(level: ProfitabilityLevel | null): string {
  return level === null ? '—' : PROFITABILITY_LABEL[level];
}
