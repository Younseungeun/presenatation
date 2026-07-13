import { describe, expect, it } from 'vitest';
import { computeCardScore, sumScores, targetPriceToMagnitudePct } from '../scoring';

describe('computeCardScore — 기본 점수 (크기 적중 비율)', () => {
  it('기획 예시: +30% 예측에 +3% 실현 = 기본 10점', () => {
    const r = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 30, confidence: 1 },
      3,
    );
    expect(r.directionHit).toBe(true);
    expect(r.baseScore).toBeCloseTo(10);
    expect(r.score).toBeCloseTo(10);
  });

  it('크기를 정확히 맞추면 기본 100점', () => {
    const r = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 10, confidence: 1 },
      10,
    );
    expect(r.baseScore).toBe(100);
  });

  it('초과 달성해도 기본 점수는 100점 상한 (구현 결정 사항)', () => {
    const r = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 1, confidence: 1 },
      10,
    );
    expect(r.baseScore).toBe(100);
  });

  it('하락 예측 적중: 음수 실현이 플러스 점수', () => {
    const r = computeCardScore(
      { direction: 'DOWN', predictedMagnitudePct: 20, confidence: 1 },
      -5,
    );
    expect(r.directionHit).toBe(true);
    expect(r.score).toBeCloseTo(25);
  });
});

describe('computeCardScore — 방향과 부호', () => {
  it('방향이 틀리면 마이너스 (대칭 구현)', () => {
    const r = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 30, confidence: 1 },
      -3,
    );
    expect(r.directionHit).toBe(false);
    expect(r.score).toBeCloseTo(-10);
  });

  it('실현 0%는 무승부 0점', () => {
    const r = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 10, confidence: 10 },
      0,
    );
    expect(r.directionHit).toBeNull();
    expect(r.score).toBe(0);
  });
});

describe('computeCardScore — 신뢰도 증폭', () => {
  it('신뢰도 1당 증폭 1: 같은 결과라도 신뢰도 10이면 10배', () => {
    const low = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 30, confidence: 1 },
      3,
    );
    const high = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 30, confidence: 10 },
      3,
    );
    expect(high.score).toBeCloseTo(low.score * 10);
  });

  it('틀렸을 때도 신뢰도만큼 증폭 (고신뢰 실패의 벌점이 큼)', () => {
    const r = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 10, confidence: 10 },
      -10,
    );
    expect(r.score).toBe(-1000);
  });

  it('신뢰도 범위(1~10)·크기 양수 검증', () => {
    expect(() =>
      computeCardScore({ direction: 'UP', predictedMagnitudePct: 10, confidence: 0 }, 1),
    ).toThrow(/신뢰도/);
    expect(() =>
      computeCardScore({ direction: 'UP', predictedMagnitudePct: 0, confidence: 5 }, 1),
    ).toThrow(/크기/);
  });
});

describe('targetPriceToMagnitudePct', () => {
  it('목표가형 카드의 크기 환산: 기준가 100,000 → 목표가 120,000 = 20%', () => {
    expect(targetPriceToMagnitudePct(120_000, 100_000)).toBeCloseTo(20);
    expect(targetPriceToMagnitudePct(80_000, 100_000)).toBeCloseTo(20);
  });
});

describe('sumScores', () => {
  it('누적 점수 합산', () => {
    expect(sumScores([{ score: 100 }, { score: -30 }, { score: 0 }])).toBe(70);
  });
});
