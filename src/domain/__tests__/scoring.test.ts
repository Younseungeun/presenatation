import { describe, expect, it } from 'vitest';
import {
  computeCardScore,
  lossAmplifier,
  optimalWinRateFor,
  scoreJudgedCard,
  sumScores,
  targetPriceToMagnitudePct,
  winAmplifier,
} from '../scoring';

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

describe('computeCardScore — 신뢰도 증폭 (proper scoring rule)', () => {
  it('적중 시 증폭은 신뢰도 그대로 (기획 원안): 신뢰도 10이면 10배', () => {
    const low = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 30, confidence: 1 },
      3,
    );
    const high = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 30, confidence: 10 },
      3,
    );
    expect(high.score).toBeCloseTo(low.score * 10);
    expect(high.amplifier).toBe(10);
  });

  it('실패 시 증폭은 c(c+1)/2 — 고신뢰 실패의 벌점이 초선형으로 큼', () => {
    expect(lossAmplifier(1)).toBe(1);
    expect(lossAmplifier(5)).toBe(15);
    expect(lossAmplifier(10)).toBe(55);

    const r = computeCardScore(
      { direction: 'UP', predictedMagnitudePct: 10, confidence: 10 },
      -10,
    );
    expect(r.amplifier).toBe(55);
    expect(r.score).toBe(-5500); // 기본 100 × 55
  });

  it('승률 50%(동전 던지기)는 어떤 신뢰도를 골라도 기대 점수 ≤ 0 (그라인딩 차단)', () => {
    for (let c = 1; c <= 10; c++) {
      const ev = 0.5 * winAmplifier(c) - 0.5 * lossAmplifier(c);
      expect(ev).toBeLessThanOrEqual(0);
    }
  });

  it('신뢰도별 최적 승률이 단조 증가 (정직한 확률 신호)', () => {
    expect(optimalWinRateFor(1)).toBeCloseTo(0.6);
    expect(optimalWinRateFor(5)).toBeCloseTo(0.846, 2);
    expect(optimalWinRateFor(10)).toBeCloseTo(0.913, 2);
    for (let c = 1; c < 10; c++) {
      expect(optimalWinRateFor(c + 1)).toBeGreaterThan(optimalWinRateFor(c));
    }
  });

  it('실제로 최적 신뢰도가 승률을 따라간다: 승률 85% 리서처는 c=5 부근이 최적', () => {
    const p = 0.85;
    const evAt = (c: number) => p * winAmplifier(c) - (1 - p) * lossAmplifier(c);
    const best = Array.from({ length: 10 }, (_, i) => i + 1).reduce((a, b) =>
      evAt(a) >= evAt(b) ? a : b,
    );
    expect(best).toBeGreaterThanOrEqual(5);
    expect(best).toBeLessThanOrEqual(6);
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

describe('scoreJudgedCard — 판정 결과 → 실현 등락률·점수', () => {
  const hit = {
    direction: 'UP' as const,
    targetType: 'RETURN_PCT' as const,
    targetValue: 10,
    confidence: 5,
    basePrice: 100,
    settledPrice: 112,
    outcome: 'HIT' as const,
  };

  it('수익률형 HIT: 실현 +12%, 기본 100(컷) × 신뢰도 5', () => {
    const r = scoreJudgedCard(hit);
    expect(r.realizedReturnPct).toBeCloseTo(12);
    expect(r.score).toBe(500);
  });

  it('목표가형: 기준가 대비 크기로 환산해 채점', () => {
    const r = scoreJudgedCard({
      ...hit,
      targetType: 'TARGET_PRICE',
      targetValue: 130, // 기준가 100 → +30% 예측
      settledPrice: 103, // 실현 +3% → 기본 3/30×100 = 10
      confidence: 1,
    });
    expect(r.score).toBeCloseTo(10);
  });

  it('판정 불가·기준가/종가 결측은 0점 (표본 제외)', () => {
    expect(scoreJudgedCard({ ...hit, outcome: 'UNDECIDABLE' })).toEqual({
      realizedReturnPct: null,
      score: 0,
    });
    expect(scoreJudgedCard({ ...hit, basePrice: null }).score).toBe(0);
    expect(scoreJudgedCard({ ...hit, settledPrice: null }).score).toBe(0);
  });
});
