import { describe, expect, it } from 'vitest';
import { settle, type SettlementInput, type SettlementResult } from '../settlement';

function expectConservation(input: SettlementInput, result: SettlementResult) {
  expect(
    result.researcherPayoutKrw + result.platformFeeKrw + result.buyerRefundKrw,
  ).toBe(input.amountKrw);
}

describe('settle — 적중', () => {
  it('리서처에게 (판매액 − 수수료) 정산', () => {
    const input: SettlementInput = {
      amountKrw: 30000,
      feeRateBp: 2000,
      prepaymentRatio: 0,
      outcome: 'HIT',
    };
    const r = settle(input);
    expect(r.researcherPayoutKrw).toBe(24000);
    expect(r.platformFeeKrw).toBe(6000);
    expect(r.buyerRefundKrw).toBe(0);
    expect(r.refundType).toBeNull();
    expectConservation(input, r);
  });
});

describe('settle — 실패', () => {
  it('완전 성과 연동(선결제 0%): 전액 구매자 현금 환불, 리서처·플랫폼 0원', () => {
    const input: SettlementInput = {
      amountKrw: 30000,
      feeRateBp: 2000,
      prepaymentRatio: 0,
      outcome: 'MISS',
    };
    const r = settle(input);
    expect(r.researcherPayoutKrw).toBe(0);
    expect(r.platformFeeKrw).toBe(0);
    expect(r.buyerRefundKrw).toBe(30000);
    expect(r.refundType).toBe('CASH_REFUND');
    expectConservation(input, r);
  });

  it('선결제 30%: 선결제분(수수료 차감 후)은 리서처, 성과 연동분은 현금 환불', () => {
    const input: SettlementInput = {
      amountKrw: 30000,
      feeRateBp: 1900, // 예시 총 수수료 19% (정산 로직은 등급과 무관하게 bp만 사용)
      prepaymentRatio: 30,
      outcome: 'MISS',
    };
    const r = settle(input);
    // 선결제분 9,000원 중 수수료 19% = 1,710원
    expect(r.researcherPayoutKrw).toBe(7290);
    expect(r.platformFeeKrw).toBe(1710);
    expect(r.buyerRefundKrw).toBe(21000);
    expect(r.refundType).toBe('CASH_REFUND');
    expectConservation(input, r);
  });
});

describe('settle — 판정 불가', () => {
  it('전액 현금 환불, 수수료 미발생', () => {
    const input: SettlementInput = {
      amountKrw: 30000,
      feeRateBp: 2000,
      prepaymentRatio: 30,
      outcome: 'UNDECIDABLE',
    };
    const r = settle(input);
    expect(r.researcherPayoutKrw).toBe(0);
    expect(r.platformFeeKrw).toBe(0);
    expect(r.buyerRefundKrw).toBe(30000);
    expect(r.refundType).toBe('CASH_REFUND');
    expectConservation(input, r);
  });
});

describe('settle — 입력 검증', () => {
  it('0원 이하 또는 정수가 아닌 금액은 에러', () => {
    expect(() =>
      settle({ amountKrw: 0, feeRateBp: 2000, prepaymentRatio: 0, outcome: 'HIT' }),
    ).toThrow();
    expect(() =>
      settle({ amountKrw: 100.5, feeRateBp: 2000, prepaymentRatio: 0, outcome: 'HIT' }),
    ).toThrow();
  });
});
