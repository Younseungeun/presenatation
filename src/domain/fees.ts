import type { PrepaymentRatio, Tier } from './constants';

// 수수료는 basis point(1bp = 0.01%)로 계산해 부동소수점 오차를 배제한다.
// "PG 포함 총 20%" 단순 고지 정책에 따라 이 값이 구매자·리서처에게 보이는 총 수수료다.

export const TIER_BASE_FEE_BP: Record<Tier, number> = {
  BRONZE: 2000,
  SILVER: 1700,
  GOLD: 1500,
  PLATINUM: 1300,
  CHALLENGER: 1000,
};

// 등급별 선결제 비율 상한 (해금 특권)
export const TIER_MAX_PREPAYMENT: Record<Tier, PrepaymentRatio> = {
  BRONZE: 0,
  SILVER: 10,
  GOLD: 20,
  PLATINUM: 30,
  CHALLENGER: 30,
};

// 선결제 비율별 수수료 할증 (기본 수수료에 가산)
export const PREPAYMENT_SURCHARGE_BP: Record<PrepaymentRatio, number> = {
  0: 0,
  10: 200,
  20: 400,
  30: 600,
};

// 초기 입점 프로모션: 첫 6개월 기본 수수료 10%
export const PROMO_BASE_FEE_BP = 1000;

export interface FeeInput {
  tier: Tier;
  prepaymentRatio: PrepaymentRatio;
  promoActive?: boolean;
}

/**
 * 리포트 게시 시점의 총 수수료(bp)를 확정한다. 게시 후 변경 불가.
 * 선결제 할증은 프로모션 여부와 무관하게 가산한다.
 * @throws 등급이 허용하지 않는 선결제 비율이면 에러
 */
export function calcFeeRateBp({ tier, prepaymentRatio, promoActive = false }: FeeInput): number {
  if (prepaymentRatio > TIER_MAX_PREPAYMENT[tier]) {
    throw new Error(
      `${tier} 등급은 선결제 ${TIER_MAX_PREPAYMENT[tier]}%까지만 허용됩니다 (요청: ${prepaymentRatio}%)`,
    );
  }
  const base = promoActive ? PROMO_BASE_FEE_BP : TIER_BASE_FEE_BP[tier];
  return base + PREPAYMENT_SURCHARGE_BP[prepaymentRatio];
}

/** 금액에 bp 수수료율 적용 (원 단위 반올림) */
export function applyFeeBp(amountKrw: number, feeRateBp: number): number {
  return Math.round((amountKrw * feeRateBp) / 10000);
}
