import { describe, expect, it } from 'vitest';
import { applyFeeBp, calcFeeRateBp } from '../fees';

describe('calcFeeRateBp — 등급 기본 수수료 + 선결제 할증', () => {
  it('브론즈는 완전 성과 연동만 가능하며 총 20%', () => {
    expect(calcFeeRateBp({ tier: 'BRONZE', prepaymentRatio: 0 })).toBe(2000);
  });

  it('브론즈가 선결제를 시도하면 에러', () => {
    expect(() => calcFeeRateBp({ tier: 'BRONZE', prepaymentRatio: 10 })).toThrow();
  });

  it('실버는 수수료 15%로 인하되지만 선결제는 아직 불가 (100% 성과 연동 유지)', () => {
    expect(calcFeeRateBp({ tier: 'SILVER', prepaymentRatio: 0 })).toBe(1500);
    expect(() => calcFeeRateBp({ tier: 'SILVER', prepaymentRatio: 10 })).toThrow();
  });

  it('골드부터 선결제 해금: 골드 + 선결제 10% = 15% + 2%p = 17%', () => {
    expect(calcFeeRateBp({ tier: 'GOLD', prepaymentRatio: 10 })).toBe(1700);
  });

  it('플래티넘 + 선결제 20% = 13% + 4%p = 17%', () => {
    expect(calcFeeRateBp({ tier: 'PLATINUM', prepaymentRatio: 20 })).toBe(1700);
  });

  it('챌린저 + 선결제 30% = 10% + 6%p = 16%', () => {
    expect(calcFeeRateBp({ tier: 'CHALLENGER', prepaymentRatio: 30 })).toBe(1600);
  });

  it('등급 상한 초과 선결제는 에러 (골드 20%, 플래티넘 30%)', () => {
    expect(() => calcFeeRateBp({ tier: 'GOLD', prepaymentRatio: 20 })).toThrow();
    expect(() => calcFeeRateBp({ tier: 'PLATINUM', prepaymentRatio: 30 })).toThrow();
  });

  it('입점 프로모션 중에는 기본 수수료 10%, 할증은 그대로 가산', () => {
    expect(calcFeeRateBp({ tier: 'BRONZE', prepaymentRatio: 0, promoActive: true })).toBe(1000);
    expect(calcFeeRateBp({ tier: 'GOLD', prepaymentRatio: 10, promoActive: true })).toBe(1200);
  });
});

describe('applyFeeBp', () => {
  it('30,000원에 20% 수수료 = 6,000원', () => {
    expect(applyFeeBp(30000, 2000)).toBe(6000);
  });

  it('원 단위 반올림', () => {
    expect(applyFeeBp(9999, 1700)).toBe(1700); // 1699.83 → 1700
  });
});
