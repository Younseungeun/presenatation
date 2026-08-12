import { describe, expect, it } from 'vitest';
import { evaluateTier, evaluateTierAcrossAssetClasses } from '../tiers';

describe('evaluateTier — 등급은 전적으로 점수로 산정 (경쟁적 요소)', () => {
  it('시작 등급: 점수 없으면 브론즈', () => {
    expect(evaluateTier(0)).toBe('BRONZE');
  });

  it('마이너스 점수도 브론즈', () => {
    expect(evaluateTier(-500)).toBe('BRONZE');
  });

  it('임계값 도달 시 승급 (v4 재캘리브레이션: 시니어 3,500 / 마스터 14,500 / 펠로우 23,000)', () => {
    expect(evaluateTier(3_499)).toBe('BRONZE');
    expect(evaluateTier(3_500)).toBe('SILVER');
    expect(evaluateTier(14_500)).toBe('GOLD');
    expect(evaluateTier(23_000)).toBe('PLATINUM');
  });

  it('시즌 재산정에서 점수가 낮아지면 강등 (같은 함수로 재평가)', () => {
    // 펠로우이던 리서처가 점수를 잃어 총점 5,000으로 하락 → 시니어
    expect(evaluateTier(5_000)).toBe('SILVER');
  });

  it('임계값은 주입 가능 (시뮬레이션으로 확정 예정)', () => {
    expect(evaluateTier(500, { SILVER: 300, GOLD: 600, PLATINUM: 900 })).toBe('SILVER');
  });
});

describe('evaluateTierAcrossAssetClasses — 자산군별 분리 집계 (확정 규칙)', () => {
  it('등급은 자산군별 점수 중 최고값으로 결정 (합산하지 않음)', () => {
    // 합산이면 25,000(펠로우 23,000+)이지만, 분리 원칙상 최고값 20,000(마스터)으로 판정
    expect(
      evaluateTierAcrossAssetClasses({ KR_EQUITY: 20_000, CRYPTO: 5_000 }),
    ).toBe('GOLD');
    // 코인 점수가 마이너스여도 주식 점수를 깎지 않는다
    expect(
      evaluateTierAcrossAssetClasses({ KR_EQUITY: 6_000, CRYPTO: -20_000 }),
    ).toBe('SILVER');
  });

  it('기록이 없으면 브론즈', () => {
    expect(evaluateTierAcrossAssetClasses({})).toBe('BRONZE');
  });
});
