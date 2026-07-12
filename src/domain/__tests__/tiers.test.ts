import { describe, expect, it } from 'vitest';
import { evaluateTier } from '../tiers';

describe('evaluateTier — 승급 평가 (건수 + 성과 복합 조건)', () => {
  it('시작 등급: 실적 없으면 브론즈', () => {
    expect(evaluateTier({ judgedCount: 0, hitRate: 0, hasCareerBadge: false })).toBe('BRONZE');
  });

  it('판정 10건 + 성과 기준 충족 → 실버', () => {
    expect(evaluateTier({ judgedCount: 10, hitRate: 0.5, hasCareerBadge: false })).toBe('SILVER');
  });

  it('건수는 충분해도 성과 미달이면 승급 불가', () => {
    expect(evaluateTier({ judgedCount: 30, hitRate: 0.4, hasCareerBadge: false })).toBe('BRONZE');
  });

  it('판정 25건 + 적중률 55% → 골드', () => {
    expect(evaluateTier({ judgedCount: 25, hitRate: 0.55, hasCareerBadge: false })).toBe('GOLD');
  });

  it('판정 50건 + 적중률 60% → 플래티넘', () => {
    expect(evaluateTier({ judgedCount: 50, hitRate: 0.6, hasCareerBadge: false })).toBe('PLATINUM');
  });

  it('경력 배지 보유 시 건수 기준 절반: 25건이면 플래티넘 가능', () => {
    expect(evaluateTier({ judgedCount: 25, hitRate: 0.6, hasCareerBadge: true })).toBe('PLATINUM');
  });

  it('시즌 재산정에서 성과가 떨어지면 강등 (같은 함수로 재평가)', () => {
    // 플래티넘이던 리서처가 적중률 52%로 하락 → 실버 조건만 충족
    expect(evaluateTier({ judgedCount: 60, hitRate: 0.52, hasCareerBadge: false })).toBe('SILVER');
  });
});
