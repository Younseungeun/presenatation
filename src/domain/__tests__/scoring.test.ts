import { describe, expect, it } from 'vitest';
import {
  computeDirectionScore,
  computeStabilityScore,
  DIRECTION_SCALE,
  lossAmplifier,
  scoreJudgedCard,
  STABILITY_BASE_SCORE,
  STABILITY_TOLERANCE,
  targetPriceToMagnitudePct,
  winAmplifier,
} from '../scoring';

describe('computeDirectionScore — 시장 기준선 대비 개선 거리 (v3)', () => {
  it('완벽 예측: +10% 예측에 실현 +10% → 거리 +10, 점수 10×10×c', () => {
    const r = computeDirectionScore('UP', 10, 5, 10);
    expect(r.distance).toBeCloseTo(10);
    expect(r.score).toBeCloseTo(DIRECTION_SCALE * 10 * 5); // +500
  });

  it('큰 적중은 큰 점수: +30% 예측에 실현 +30%는 +10% 완벽 적중의 3배 (100컷 폐지)', () => {
    const small = computeDirectionScore('UP', 10, 1, 10);
    const big = computeDirectionScore('UP', 30, 1, 30);
    expect(big.score).toBeCloseTo(small.score * 3);
  });

  it('본전선 = 예측의 절반: +10% 예측에 실현 +5% → 거리 0, 점수 0', () => {
    const r = computeDirectionScore('UP', 10, 5, 5);
    expect(r.distance).toBeCloseTo(0);
    expect(r.score).toBe(0);
  });

  it('절반 미달이면 방향이 맞아도 마이너스: +30% 예측에 실현 +3% → 거리 −24', () => {
    const r = computeDirectionScore('UP', 30, 1, 3);
    expect(r.distance).toBeCloseTo(3 - 27);
    expect(r.score).toBeCloseTo(DIRECTION_SCALE * -24 * lossAmplifier(1));
  });

  it('초과해도 상한은 자기 주장 크기: +10% 예측에 실현 +40% → 거리 +10 (과소 신고는 스스로 손해)', () => {
    const r = computeDirectionScore('UP', 10, 5, 40);
    expect(r.distance).toBeCloseTo(10);
    // 정직하게 +40%를 신고했다면 4배를 벌었다
    const honest = computeDirectionScore('UP', 40, 5, 40);
    expect(honest.score).toBeCloseTo(r.score * 4);
  });

  it('방향 반대는 얼마나 빠지든 정확히 −|R̂| (자기 주장 크기만큼만 건다)', () => {
    expect(computeDirectionScore('UP', 10, 1, -3).distance).toBeCloseTo(-10);
    expect(computeDirectionScore('UP', 10, 1, -30).distance).toBeCloseTo(-10);
  });

  it('하락 예측 대칭: −20% 예측에 실현 −20% → +20 / 실현 −5% → −10', () => {
    expect(computeDirectionScore('DOWN', 20, 1, -20).distance).toBeCloseTo(20);
    expect(computeDirectionScore('DOWN', 20, 1, -5).distance).toBeCloseTo(-10);
  });

  it('크기 정직 신고가 최적 (median-truthful): 믿음 {0%:25%, +10%:50%, +20%:25%}이면 +10% 신고가 기대 거리 최대', () => {
    const belief: Array<[number, number]> = [
      [0, 0.25],
      [10, 0.5],
      [20, 0.25],
    ];
    const evDistance = (claim: number) =>
      belief.reduce(
        (a, [r, p]) => a + p * computeDirectionScore('UP', claim, 1, r).distance,
        0,
      );
    expect(evDistance(10)).toBeGreaterThan(evDistance(5));
    expect(evDistance(10)).toBeGreaterThan(evDistance(20));
  });

  it('무정보 예측은 증폭 이전에 이미 기대 거리 음수 (스팸 구조 차단)', () => {
    // 대칭 믿음 {−10, 0, +10} 각 1/3 — 어느 방향·크기를 신고해도 E[D] < 0
    const belief = [-10, 0, 10];
    for (const claim of [5, 10, 20]) {
      const ev =
        belief.reduce(
          (a, r) => a + computeDirectionScore('UP', claim, 1, r).distance,
          0,
        ) / belief.length;
      expect(ev).toBeLessThan(0);
    }
  });

  it('신뢰도 증폭 비대칭: 개선 ×c, 악화 ×c(c+1)/2', () => {
    expect(winAmplifier(10)).toBe(10);
    expect(lossAmplifier(1)).toBe(1);
    expect(lossAmplifier(5)).toBe(15);
    expect(lossAmplifier(10)).toBe(55);
    const bad = computeDirectionScore('UP', 10, 10, -5);
    expect(bad.score).toBeCloseTo(DIRECTION_SCALE * -10 * 55);
  });

  it('신뢰도 범위(1~10)·크기 양수 검증', () => {
    expect(() => computeDirectionScore('UP', 10, 0, 1)).toThrow(/신뢰도/);
    expect(() => computeDirectionScore('UP', 0, 5, 1)).toThrow(/크기/);
  });
});

describe('computeStabilityScore — 연속 램프 정밀도 배팅 (v3)', () => {
  // 기준 케이스: CRYPTO(바닥 10), M=10, s=5 → 스테이크 s−1=4
  it('정확히 명중(ε=0)이면 만점 +P₀×(s−1)', () => {
    const r = computeStabilityScore('UP', 10, 5, 10, 10);
    expect(r.normalizedError).toBeCloseTo(0);
    expect(r.score).toBeCloseTo(STABILITY_BASE_SCORE * 4); // +200
  });

  it('오차가 커질수록 선형으로 줄어 T에서 0 — 절벽이 없다', () => {
    const half = computeStabilityScore('UP', 10, 5, 10 - 10 * (STABILITY_TOLERANCE / 2), 10);
    expect(half.score).toBeCloseTo(STABILITY_BASE_SCORE * 4 * 0.5); // +100
    const atT = computeStabilityScore('UP', 10, 5, 10 - 10 * STABILITY_TOLERANCE, 10);
    expect(atT.score).toBeCloseTo(0);
  });

  it('T를 지나면 벌점이 차오르다 2T에서 최대 −P₀×(s−1)s/2 (그 너머는 상한)', () => {
    const quarterIn = computeStabilityScore('UP', 10, 5, 10 - 10 * STABILITY_TOLERANCE * 1.25, 10);
    expect(quarterIn.score).toBeCloseTo(-STABILITY_BASE_SCORE * 10 * 0.25); // −125
    const atMax = computeStabilityScore('UP', 10, 5, -5, 10); // δ=−1.5=2T
    expect(atMax.score).toBeCloseTo(-STABILITY_BASE_SCORE * 10); // −500
    const beyond = computeStabilityScore('UP', 10, 5, -30, 10);
    expect(beyond.score).toBeCloseTo(-STABILITY_BASE_SCORE * 10); // 상한 유지
  });

  it('초과는 1.5배 관대: 같은 거리라도 초과(+7.5%p)는 가점, 미달(−7.5%p)은 0', () => {
    const over = computeStabilityScore('UP', 10, 5, 17.5, 10); // δ=+0.75 → ε=0.5
    const under = computeStabilityScore('UP', 10, 5, 2.5, 10); // δ=−0.75 → ε=0.75
    expect(over.score).toBeGreaterThan(0);
    expect(under.score).toBeCloseTo(0);
  });

  it('정규화 바닥: 예측 크기가 바닥보다 작으면 바닥(%p)으로 나눈다 (초소형 오차 과대평가 방지)', () => {
    // M=5, 바닥 10 → 실현 2%의 편차는 (2−5)/10 = −0.3
    const r = computeStabilityScore('UP', 5, 5, 2, 10);
    expect(r.normalizedError).toBeCloseTo(0.3);
    expect(r.score).toBeCloseTo(STABILITY_BASE_SCORE * 4 * (1 - 0.3 / STABILITY_TOLERANCE));
  });

  it('하락 예측 대칭: −10% 목표에 실현 −12%는 초과(관대), 실현 −8%는 미달', () => {
    const over = computeStabilityScore('DOWN', 10, 5, -12, 10);
    expect(over.normalizedError).toBeCloseTo(0.2 / 1.5);
    const under = computeStabilityScore('DOWN', 10, 5, -8, 10);
    expect(under.normalizedError).toBeCloseTo(0.2);
    expect(over.score).toBeGreaterThan(under.score);
  });

  it('s=1은 진짜 불참: 명중이든 대이탈이든 0점', () => {
    expect(computeStabilityScore('UP', 10, 1, 10, 10).score).toBe(0);
    expect(computeStabilityScore('UP', 10, 1, -30, 10).score).toBe(0);
  });

  it('명중 확률이 절반쯤이면 s≥2 배팅은 기대 손실 (그라인딩 차단 — 스테이크 비대칭)', () => {
    // q 기대값 0.5, m 기대값 0.5인 극단 가정에서도 s가 클수록 손해
    for (let s = 2; s <= 10; s++) {
      const ev = 0.5 * (s - 1) - 0.5 * (((s - 1) * s) / 2);
      expect(ev).toBeLessThanOrEqual(0);
    }
  });

  it('안정성 범위(1~10) 검증', () => {
    expect(() => computeStabilityScore('UP', 10, 0, 5, 10)).toThrow(/안정성/);
    expect(() => computeStabilityScore('UP', 10, 11, 5, 10)).toThrow(/안정성/);
  });
});

describe('targetPriceToMagnitudePct', () => {
  it('목표가형 카드의 크기 환산: 기준가 100,000 → 목표가 120,000 = 20%', () => {
    expect(targetPriceToMagnitudePct(120_000, 100_000)).toBeCloseTo(20);
    expect(targetPriceToMagnitudePct(80_000, 100_000)).toBeCloseTo(20);
  });
});

describe('scoreJudgedCard — 판정 결과 → 실현 등락률·점수 (v3)', () => {
  const hit = {
    direction: 'UP' as const,
    targetType: 'RETURN_PCT' as const,
    targetValue: 10,
    confidence: 5,
    stability: 5,
    assetClass: 'CRYPTO' as const,
    basePrice: 100,
    settledPrice: 112,
    outcome: 'HIT' as const,
  };

  it('수익률형 HIT: 방향 +500 (거리 10 ×10 ×c5) + 안정성 +164.4 (초과 δ=0.2 관대 오차)', () => {
    const r = scoreJudgedCard(hit);
    expect(r.realizedReturnPct).toBeCloseTo(12);
    expect(r.directionScore).toBeCloseTo(500);
    expect(r.stabilityScore).toBeCloseTo(164.44, 1);
    expect(r.score).toBeCloseTo(664.44, 1);
  });

  it('방향은 맞았지만 크게 부풀린 카드는 마이너스: +10% 예측 실현 +2% → 방향 −900, 안정성 −33', () => {
    const r = scoreJudgedCard({ ...hit, settledPrice: 102 });
    expect(r.directionScore).toBeCloseTo(-900); // 거리 −6 × 10 × 벌점 15
    expect(r.stabilityScore).toBeCloseTo(-33.33, 1);
    expect(r.score).toBeCloseTo(-933.33, 1);
  });

  it('목표가형 + s=1 불참: 기준가 대비 크기로 환산해 방향만 채점', () => {
    const r = scoreJudgedCard({
      ...hit,
      targetType: 'TARGET_PRICE',
      targetValue: 130, // 기준가 100 → +30% 예측
      settledPrice: 103, // 실현 +3% → 거리 3−27 = −24
      confidence: 1,
      stability: 1,
    });
    expect(r.directionScore).toBeCloseTo(-240);
    expect(r.stabilityScore).toBe(0);
    expect(r.score).toBeCloseTo(-240);
  });

  it('판정 불가·기준가/종가 결측은 0점 (표본 제외)', () => {
    expect(scoreJudgedCard({ ...hit, outcome: 'UNDECIDABLE' })).toEqual({
      realizedReturnPct: null,
      score: 0,
      directionScore: 0,
      stabilityScore: 0,
    });
    expect(scoreJudgedCard({ ...hit, basePrice: null }).score).toBe(0);
    expect(scoreJudgedCard({ ...hit, settledPrice: null }).score).toBe(0);
  });

  it('실현 0%는 무승부 — 방향·안정성 모두 0점 (표본 제외 규칙 유지)', () => {
    const r = scoreJudgedCard({ ...hit, settledPrice: 100 });
    expect(r.realizedReturnPct).toBe(0);
    expect(r.score).toBe(0);
    expect(r.stabilityScore).toBe(0);
  });
});
