import { describe, expect, it } from 'vitest';
import { evaluateTier } from '../tiers';

describe('evaluateTier — 등급은 전적으로 점수로 산정 (경쟁적 요소)', () => {
  it('시작 등급: 점수 없으면 브론즈', () => {
    expect(evaluateTier(0)).toBe('BRONZE');
  });

  it('마이너스 점수도 브론즈', () => {
    expect(evaluateTier(-500)).toBe('BRONZE');
  });

  it('임계값 도달 시 승급 (초안: 실버 1,000 / 골드 3,000 / 플래티넘 8,000)', () => {
    expect(evaluateTier(999)).toBe('BRONZE');
    expect(evaluateTier(1_000)).toBe('SILVER');
    expect(evaluateTier(3_000)).toBe('GOLD');
    expect(evaluateTier(8_000)).toBe('PLATINUM');
  });

  it('시즌 재산정에서 점수가 낮아지면 강등 (같은 함수로 재평가)', () => {
    // 플래티넘이던 리서처가 마이너스 점수를 쌓아 총점 2,500으로 하락 → 실버
    expect(evaluateTier(2_500)).toBe('SILVER');
  });

  it('임계값은 주입 가능 (시뮬레이션으로 확정 예정)', () => {
    expect(evaluateTier(500, { SILVER: 300, GOLD: 600, PLATINUM: 900 })).toBe('SILVER');
  });
});
