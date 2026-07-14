import type { Outcome } from './constants';
import { applyFeeBp } from './fees';

// 에스크로 정산 3분기 로직.
// 불변식: researcherPayoutKrw + platformFeeKrw + buyerRefundKrw === amountKrw (구매 1건 기준)

export interface SettlementInput {
  /** 구매자 결제 총액 */
  amountKrw: number;
  /** 리포트 게시 시점 확정 수수료 (bp) */
  feeRateBp: number;
  /** 선결제 비율 (0|10|20|30) */
  prepaymentRatio: number;
  outcome: Outcome;
}

export interface SettlementResult {
  outcome: Outcome;
  researcherPayoutKrw: number;
  platformFeeKrw: number;
  buyerRefundKrw: number;
  /**
   * 환불이 발생하면 항상 현금(PG 취소 또는 계좌이체) — 확정 결정.
   * MISS/UNDECIDABLE 구분은 outcome 필드가 담당한다.
   * 카드 취소 기한(통상 1년)을 넘긴 건은 계좌이체 폴백 (운영 절차)
   */
  refundType: 'CASH_REFUND' | null;
}

/**
 * 판정 결과에 따라 에스크로 금액을 분배한다.
 * - 적중: 리서처에게 (판매액 − 수수료) 정산
 * - 실패: 성과 연동분 → 구매자에게 현금 환불, 선결제분 → 리서처 정산 (수수료는 선결제분에만 부과)
 * - 판정 불가: 전액 현금 환불, 수수료 미발생
 */
export function settle(input: SettlementInput): SettlementResult {
  const { amountKrw, feeRateBp, prepaymentRatio, outcome } = input;
  if (!Number.isInteger(amountKrw) || amountKrw <= 0) {
    throw new Error(`결제 금액이 유효하지 않습니다: ${amountKrw}`);
  }

  if (outcome === 'UNDECIDABLE') {
    return {
      outcome,
      researcherPayoutKrw: 0,
      platformFeeKrw: 0,
      buyerRefundKrw: amountKrw,
      refundType: 'CASH_REFUND',
    };
  }

  if (outcome === 'HIT') {
    const fee = applyFeeBp(amountKrw, feeRateBp);
    return {
      outcome,
      researcherPayoutKrw: amountKrw - fee,
      platformFeeKrw: fee,
      buyerRefundKrw: 0,
      refundType: null,
    };
  }

  // MISS: 선결제분은 리서처에게, 성과 연동분은 구매자에게 현금 환불
  const prepaidKrw = Math.round((amountKrw * prepaymentRatio) / 100);
  const performanceKrw = amountKrw - prepaidKrw;
  const fee = applyFeeBp(prepaidKrw, feeRateBp);
  return {
    outcome,
    researcherPayoutKrw: prepaidKrw - fee,
    platformFeeKrw: fee,
    buyerRefundKrw: performanceKrw,
    refundType: performanceKrw > 0 ? 'CASH_REFUND' : null,
  };
}
