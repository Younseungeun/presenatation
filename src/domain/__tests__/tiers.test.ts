import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIER_THRESHOLDS,
  evaluateTier,
  evaluateTierAcrossAssetClasses,
} from '../tiers';

describe('evaluateTier — 등급은 전적으로 점수로 산정 (경쟁적 요소)', () => {
  it('시작 등급: 점수 없으면 브론즈', () => {
    expect(evaluateTier(0)).toBe('BRONZE');
  });

  it('마이너스 점수도 브론즈', () => {
    expect(evaluateTier(-500)).toBe('BRONZE');
  });

  it('임계값 도달 시 승급 — 수치는 상수에서 읽는다 (재캘리브레이션마다 고쳐 적지 않게)', () => {
    const { SILVER, GOLD, PLATINUM } = DEFAULT_TIER_THRESHOLDS;
    expect(evaluateTier(SILVER - 1)).toBe('BRONZE');
    expect(evaluateTier(SILVER)).toBe('SILVER');
    expect(evaluateTier(GOLD)).toBe('GOLD');
    expect(evaluateTier(PLATINUM)).toBe('PLATINUM');
  });

  it('현재 임계값 (v5 + 연속 가중 w 재캘리브레이션, 2026-08-13)', () => {
    expect(DEFAULT_TIER_THRESHOLDS).toEqual({ SILVER: 1_200, GOLD: 2_650, PLATINUM: 5_070 });
  });

  it('시즌 재산정에서 점수가 낮아지면 강등 (같은 함수로 재평가)', () => {
    // 펠로우이던 리서처가 점수를 잃어 총점 2,000으로 하락 → 시니어
    expect(evaluateTier(2_000)).toBe('SILVER');
  });

  it('임계값은 주입 가능 (시뮬레이션으로 확정 예정)', () => {
    expect(evaluateTier(500, { SILVER: 300, GOLD: 600, PLATINUM: 900 })).toBe('SILVER');
  });
});

describe('evaluateTierAcrossAssetClasses — 자산군별 분리 집계 (확정 규칙)', () => {
  it('등급은 자산군별 점수 중 최고값으로 결정 (합산하지 않음)', () => {
    // 합산이면 펠로우지만, 분리 원칙상 최고값 하나(마스터 구간)로 판정
    expect(
      evaluateTierAcrossAssetClasses({ KR_EQUITY: 3_000, CRYPTO: 1_400 }),
    ).toBe('GOLD');
    // 코인 점수가 마이너스여도 주식 점수를 깎지 않는다
    expect(
      evaluateTierAcrossAssetClasses({ KR_EQUITY: 1_400, CRYPTO: -20_000 }),
    ).toBe('SILVER');
  });

  it('기록이 없으면 브론즈', () => {
    expect(evaluateTierAcrossAssetClasses({})).toBe('BRONZE');
  });
});
