import { describe, expect, it } from 'vitest';
import {
  PROFITABILITY_PAYOUT_MULTIPLE,
  PROFITABILITY_BOUNDS,
  PROFITABILITY_BASE_PCT,
  computeReachScore,
  confidenceOddsMultiple,
  magnitudeWeight,
  SCORE_SCALE,
  CONFIDENCE_RANGE,
  DISCIPLINE_LADDER,
  disciplineFor,
  honestConfidence,

  magnitudePctToTargetPrice,
  maxMagnitudePct,
  minMagnitudePct,
  ABSOLUTE_MIN_MAGNITUDE_PCT,
  DAILY_SIGMA,
  noSkillTouchProbability,
  scoreJudgedCard,
  targetPriceToMagnitudePct,
  UNMEASURED_SIGMA,
} from '../scoring';

// 점수 모델 v4 (공정배당 이항) — 수학적 성질을 코드로 고정한다.
// 여기 깨지면 등급·정산의 공정성 주장이 통째로 깨지는 것이다.

describe('무정보 도달 확률 p₀', () => {
  it('고정 5%/30일은 무정보로도 절반 넘게 닿는다 — 고정 %가 하한이 될 수 없다는 사실', () => {
    // 자산군 평균 σ(2%)로 재면 0.56. 여기서 σ를 넣지 않으면 **못 잰 종목의 폴백**
    // (7.05%)이 쓰여 더 높게 나오는데, 그것도 같은 이야기의 강한 판본이다
    expect(noSkillTouchProbability('UP', 5, 'KR_EQUITY', 30, DAILY_SIGMA.KR_EQUITY)).toBeGreaterThan(0.5);
    expect(noSkillTouchProbability('UP', 5, 'KR_EQUITY', 30, DAILY_SIGMA.KR_EQUITY)).toBeLessThan(0.62);
    expect(noSkillTouchProbability('UP', 5, 'KR_EQUITY', 30)).toBeGreaterThan(0.7);
  });

  it('크기가 클수록 단조 감소한다', () => {
    let prev = 1;
    for (const m of [5, 10, 15, 25, 40]) {
      const p = noSkillTouchProbability('UP', m, 'KR_EQUITY', 30);
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it('기간이 길수록 단조 증가한다', () => {
    let prev = 0;
    for (const h of [7, 30, 90, 180]) {
      const p = noSkillTouchProbability('UP', 10, 'KR_EQUITY', h);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('같은 크기면 하락 카드의 p₀가 약간 크다 — 마팅게일 로그 드리프트(−σ²/2)가 아래로 민다', () => {
    const up = noSkillTouchProbability('UP', 10, 'CRYPTO', 30);
    const down = noSkillTouchProbability('DOWN', 10, 'CRYPTO', 30);
    expect(down).toBeGreaterThan(up);
  });

  it('자산군이 달라도 **하한 카드의 p₀는 같다** — 하한이 변동성에 맞춰 설계된 증거', () => {
    // 고정 %를 비교하면 자산군마다 다른 답이 나온다. 비교할 것은 각 자산군의 하한이다
    const at = (assetClass: 'KR_EQUITY' | 'CRYPTO', sigma: number) =>
      noSkillTouchProbability('UP', minMagnitudePct(assetClass, sigma, 30), assetClass, 30, sigma);
    expect(Math.abs(at('KR_EQUITY', DAILY_SIGMA.KR_EQUITY) - at('CRYPTO', DAILY_SIGMA.CRYPTO))).toBeLessThan(0.05);
  });

  it('극단값은 클램프된다', () => {
    expect(noSkillTouchProbability('UP', 300, 'KR_EQUITY', 7)).toBeGreaterThanOrEqual(0.01);
    expect(noSkillTouchProbability('UP', 5, 'CRYPTO', 365)).toBeLessThanOrEqual(0.95);
  });
});

describe('공정배당 — 무정보 EV ≤ 0 (스팸이 구조적으로 못 번다)', () => {
  // EV₀ = p₀·hit + (1−p₀)·miss = −B·p₀(1−p₀)·c(c−1)/2 — c=1에서만 0
  it('**쓸 수 있는 모든 (크기, 기간, c)에서 무정보 기대 점수가 0보다 작다**', () => {
    // 신뢰도 하한이 2로 오르면서 은신처가 닫혔다. 예전에는 c=1에서 EV가 정확히 0이라
    // "벌지는 못하지만 잃지도 않는" 자리가 남아 있었다 (아래 테스트가 그 사실을 고정한다)
    for (const m of [5, 10, 25, 40]) {
      for (const h of [7, 30, 120]) {
        for (let c = CONFIDENCE_RANGE.min; c <= CONFIDENCE_RANGE.max; c++) {
          const { p0, score: hit } = computeReachScore('UP', m, c, 'KR_EQUITY', h, true);
          const { score: miss } = computeReachScore('UP', m, c, 'KR_EQUITY', h, false);
          expect(p0 * hit + (1 - p0) * miss, `M=${m} H=${h} c=${c}`).toBeLessThan(0);
        }
      }
    }
  });

  it('c=1이 은신처였다는 사실이 하한 2의 근거다 — 공식으로 고정한다', () => {
    // c=1은 이제 범위 밖이라 computeReachScore가 거부한다(그게 하한의 집행이다).
    // 무정보 EV = −B·p₀(1−p₀)·c(c−1)/2 는 c=1에서 정확히 0이고 c=2부터 음수다.
    expect(CONFIDENCE_RANGE.min).toBe(2);
    expect(() => computeReachScore('UP', 10, 1, 'CRYPTO', 30, true)).toThrow();

    const p0 = noSkillTouchProbability('UP', 10, 'CRYPTO', 30);
    const noSkillEv = (c: number) => -10 * 10 * p0 * (1 - p0) * ((c * (c - 1)) / 2);
    expect(noSkillEv(1)).toBeCloseTo(0, 12);
    expect(noSkillEv(CONFIDENCE_RANGE.min)).toBeLessThan(0);
  });
});

describe('정직한 신뢰도 — c* = 무정보 대비 승산 배수', () => {
  it('c→c+1 이득 경계가 odds(p) = (c+1)·odds(p₀)에 있다', () => {
    const p0 = noSkillTouchProbability('UP', 10, 'KR_EQUITY', 30);
    const odds0 = p0 / (1 - p0);
    const c = 3;
    // 경계 확률: odds(p) = (c+1)·odds₀
    const pB = ((c + 1) * odds0) / (1 + (c + 1) * odds0);
    const ev = (cc: number, p: number) => {
      const hit = computeReachScore('UP', 10, cc, 'KR_EQUITY', 30, true).score;
      const miss = computeReachScore('UP', 10, cc, 'KR_EQUITY', 30, false).score;
      return p * hit + (1 - p) * miss;
    };
    // 경계 바로 위에서는 c+1이 낫고, 바로 아래에서는 c가 낫다
    expect(ev(c + 1, pB + 0.01)).toBeGreaterThan(ev(c, pB + 0.01));
    expect(ev(c + 1, pB - 0.01)).toBeLessThan(ev(c, pB - 0.01));
  });

  it('honestConfidence는 배수를 그대로 돌려주고 허용 범위에 갇힌다', () => {
    // 승산 우위가 없어도 하한 2로 올라온다 — 그런 사람은 애초에 게시하지 않는 것이 맞고,
    // 게시한다면 그 카드의 기대 점수는 음수다(위 공정배당 테스트)
    expect(honestConfidence(0.5, 0.5)).toBe(CONFIDENCE_RANGE.min);
    // odds(0.75)=3, odds(0.5)=1 → 3배
    expect(honestConfidence(0.75, 0.5)).toBe(3);
    expect(honestConfidence(0.999, 0.05)).toBe(CONFIDENCE_RANGE.max);
    expect(honestConfidence(0.01, 0.5)).toBe(CONFIDENCE_RANGE.min);
  });
});

describe('배당 구조', () => {
  it('적중 = +ln(p̂/p₀), 실패 = +ln((1−p̂)/(1−p₀)) — 기준 대비 정보량', () => {
    const m = 10;
    const c = 4;
    const hit = computeReachScore('UP', m, c, 'CRYPTO', 30, true);
    const miss = computeReachScore('UP', m, c, 'CRYPTO', 30, false);
    const w = SCORE_SCALE * magnitudeWeight('CRYPTO', m);
    expect(hit.score).toBeCloseTo(w * Math.log(hit.claimed / hit.p0), 9);
    expect(miss.score).toBeCloseTo(w * Math.log((1 - miss.claimed) / (1 - miss.p0)), 9);
    // 적중은 이득, 실패는 손해 — 신고가 무정보보다 위일 때(c > 1)
    expect(hit.score).toBeGreaterThan(0);
    expect(miss.score).toBeLessThan(0);
  });

  it('신고 확률 p̂는 무정보 승산을 사다리 배수만큼 증폭한 값이다', () => {
    const { p0, claimed } = computeReachScore('UP', 10, 5, 'CRYPTO', 30, true);
    const odds = (p: number) => p / (1 - p);
    expect(odds(claimed) / odds(p0)).toBeCloseTo(confidenceOddsMultiple(5), 6);
  });

  it('실패 벌점은 게시 사양만의 함수 — 같은 사양이면 항상 같다 (하방 확정)', () => {
    const a = computeReachScore('UP', 15, 7, 'KR_EQUITY', 60, false).score;
    const b = computeReachScore('UP', 15, 7, 'KR_EQUITY', 60, false).score;
    expect(a).toBe(b);
  });

  it('어려운 목표일수록 적중 보상이 크다 — (1−p₀)와 B가 함께 커진다', () => {
    const easy = computeReachScore('UP', 5, 5, 'KR_EQUITY', 30, true).score;
    const hard = computeReachScore('UP', 25, 5, 'KR_EQUITY', 30, true).score;
    expect(hard).toBeGreaterThan(easy * 3);
  });
});

describe('scoreJudgedCard', () => {
  const base = {
    direction: 'UP' as const,
    targetType: 'RETURN_PCT' as const,
    targetValue: 10,
    confidence: 5,
    assetClass: 'CRYPTO' as const,
    // 종목 σ 미상 — 자산군 σ̄로 폴백되는 경로를 기본으로 둔다
    sigmaDaily: null,
    basePrice: 100,
    horizonDays: 30,
  };

  it('적중 점수 = computeReachScore와 동일 (판정가와 무관 — 주장이 이항이라)', () => {
    const r = scoreJudgedCard({ ...base, settledPrice: 110, outcome: 'HIT' });
    const expected = computeReachScore('UP', 10, 5, 'CRYPTO', 30, true).score;
    expect(r.score).toBeCloseTo(expected, 6);
    expect(r.realizedReturnPct).toBeCloseTo(10);
  });

  it('안정성 성분은 v4에서 항상 0이다 — 입력 자체가 사라졌고 반환값만 호환용으로 남는다', () => {
    const r = scoreJudgedCard({ ...base, settledPrice: 110, outcome: 'HIT' });
    expect(r.stabilityScore).toBe(0);
    // 방향·크기 성분이 곧 총점 (감사·화면 표시가 같은 값을 본다)
    expect(r.directionScore).toBe(r.score);
  });

  it('목표가형은 기준가 대비 크기로 환산해 같은 규칙을 탄다', () => {
    const r = scoreJudgedCard({
      ...base,
      targetType: 'TARGET_PRICE',
      targetValue: 110, // 기준 100 → +10%
      settledPrice: 110,
      outcome: 'HIT',
    });
    const expected = computeReachScore('UP', 10, 5, 'CRYPTO', 30, true).score;
    expect(r.score).toBeCloseTo(expected, 6);
  });

  it('판정 불가·기준가 없음·기간 없음은 0점 (표본 제외)', () => {
    expect(scoreJudgedCard({ ...base, settledPrice: 110, outcome: 'UNDECIDABLE' }).score).toBe(0);
    expect(
      scoreJudgedCard({ ...base, basePrice: null, settledPrice: 110, outcome: 'HIT' }).score,
    ).toBe(0);
    expect(
      scoreJudgedCard({ ...base, horizonDays: null, settledPrice: 110, outcome: 'HIT' }).score,
    ).toBe(0);
  });
});

describe('크기 환산 왕복', () => {
  it('targetPriceToMagnitudePct ↔ magnitudePctToTargetPrice는 서로의 역이다', () => {
    for (const [base, dir, m] of [
      [71_000, 'UP', 12],
      [198_000, 'DOWN', 8],
      [100, 'UP', 33.3],
    ] as const) {
      const target = magnitudePctToTargetPrice(base, dir, m);
      expect(targetPriceToMagnitudePct(target, base)).toBeCloseTo(m, 9);
    }
  });
});

describe('기간 반영 크기 상한', () => {
  it('30일 기준값이고 √시간으로 스케일한다', () => {
    const sigma = DAILY_SIGMA.KR_EQUITY;
    expect(maxMagnitudePct('KR_EQUITY', 30, sigma)).toBeCloseTo(50);
    expect(maxMagnitudePct('KR_EQUITY', 120, sigma)).toBeCloseTo(100);
    expect(maxMagnitudePct('CRYPTO', 30, DAILY_SIGMA.CRYPTO)).toBeCloseTo(120);
  });
});

describe('규율 래더', () => {
  it('증거가 깊어질수록 신뢰도 상한이 내려가고 최하단은 게시 정지', () => {
    expect(disciplineFor(0).maxConfidence).toBe(CONFIDENCE_RANGE.max);
    expect(disciplineFor(-3).maxConfidence).toBe(6);
    expect(disciplineFor(-4.7).maxConfidence).toBe(4);
    expect(disciplineFor(-7).maxConfidence).toBe(2);
    expect(disciplineFor(-9.3).publishSuspended).toBe(true);
  });

  it('처방이 상한인 이유 — 하한을 올리면 플랫폼이 거짓 신고를 요구하게 된다', () => {
    // 적정 점수법에서 신뢰도는 확률 신고다. 무실력자에게 "더 높게 부르라"고 하면
    // 그의 기대 정보량은 **더 깊게** 음수가 된다 — 처벌이 아니라 함정이다.
    const p0 = noSkillTouchProbability('UP', 5, 'KR_EQUITY', 30);
    const evAt = (c: number) =>
      p0 * computeReachScore('UP', 5, c, 'KR_EQUITY', 30, true).info +
      (1 - p0) * computeReachScore('UP', 5, c, 'KR_EQUITY', 30, false).info;
    expect(evAt(CONFIDENCE_RANGE.min)).toBeLessThan(0);
    expect(evAt(10)).toBeLessThan(evAt(CONFIDENCE_RANGE.min));
    // 그래서 래더는 상한만 내린다 — 어느 단도 하한을 건드리지 않는다
    expect(DISCIPLINE_LADDER.every((r) => r.maxConfidence <= CONFIDENCE_RANGE.max)).toBe(true);
    expect(DISCIPLINE_LADDER.every((r) => r.maxConfidence >= CONFIDENCE_RANGE.min)).toBe(true);
  });
});

describe('예측 크기 하한 — 종목 변동성 연동', () => {
  it('**핵심 불변식**: 하한 카드의 무정보 도달 확률이 종목 변동성과 무관하다', () => {
    // 이것이 "변동성으로만 hit을 노릴 수 없다"의 수학적 진술이다.
    // 하한 = k·σ·√H라 정규화 장벽 거리가 k로 고정되고, p₀는 그 거리의 함수다.
    const p0 = [0.008, 0.021, 0.037, 0.06].map((sigma) =>
      noSkillTouchProbability('UP', minMagnitudePct('KR_EQUITY', sigma, 30), 'KR_EQUITY', 30, sigma),
    );
    // 잔차는 이산 관측 보정(BGK)과 마팅게일 드리프트에서만 나온다 — 3%p 안쪽
    expect(Math.max(...p0) - Math.min(...p0)).toBeLessThan(0.03);
  });

  it('고정 하한이었다면 그 확률이 크게 벌어진다 (회귀 방지 대조군)', () => {
    const fixed = [0.008, 0.06].map((sigma) =>
      noSkillTouchProbability('UP', 5, 'KR_EQUITY', 30, sigma),
    );
    // 고정 5%: 조용한 종목 ~22% vs 거친 종목 ~76% — 거친 종목을 고르는 것만으로 이득
    expect(fixed[1] - fixed[0]).toBeGreaterThan(0.4);
  });

  it('거친 종목일수록, 기한이 길수록 하한이 올라간다', () => {
    expect(minMagnitudePct('KR_EQUITY', 0.06, 30)).toBeGreaterThan(
      minMagnitudePct('KR_EQUITY', 0.008, 30),
    );
    expect(minMagnitudePct('KR_EQUITY', 0.021, 90)).toBeGreaterThan(
      minMagnitudePct('KR_EQUITY', 0.021, 7),
    );
  });

  it('σ가 없으면 **거친 쪽**으로 물러선다 — 지어내지 않되, 모르는 대가는 리서처가 진다', () => {
    for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as const) {
      expect(minMagnitudePct(assetClass, null, 30)).toBeCloseTo(
        minMagnitudePct(assetClass, UNMEASURED_SIGMA[assetClass], 30),
        6,
      );
      // 평균으로 물러서면 안 된다 — 그 자리가 무실력 파밍이 열리던 구멍이다
      expect(minMagnitudePct(assetClass, null, 30)).toBeGreaterThan(
        minMagnitudePct(assetClass, DAILY_SIGMA[assetClass], 30),
      );
    }
  });

  it('**σ를 못 잰 주식에서 무실력 기대값이 0을 넘지 않는다** — 폴백을 평균으로 되돌리면 깨진다', () => {
    // 이 시험이 없어서 구멍이 오래 열려 있었다. 실력 0인 사람이 σ 미측정 종목만 골라
    // 하한 크기로 카드를 낼 때의 카드당 기대 점수를, 실제 σ를 바꿔 가며 확인한다
    // (scripts/probeNewListingSigma.ts가 같은 계산을 표로 보여준다)
    for (const days of [7, 14, 30, 90]) {
      for (const realSigma of [0.04, 0.06, 0.08]) {
        for (const c of [2, 5, 10]) {
          const floor = minMagnitudePct('KR_EQUITY', null, days);
          const trueP = noSkillTouchProbability('UP', floor, 'KR_EQUITY', days, realSigma);
          const hit = computeReachScore('UP', floor, c, 'KR_EQUITY', days, true, null).score;
          const miss = computeReachScore('UP', floor, c, 'KR_EQUITY', days, false, null).score;
          expect(trueP * hit + (1 - trueP) * miss).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  it('절대 바닥 아래로 내려가지 않는다 — 왕복 거래비용보다 작은 목표는 조언이 아니다', () => {
    expect(minMagnitudePct('KR_EQUITY', 0.0005, 1)).toBe(ABSOLUTE_MIN_MAGNITUDE_PCT);
  });

  it('**하한이 상한을 넘지 않는다** — 넘으면 게시 가능한 크기가 하나도 없어진다', () => {
    for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as const) {
      for (const sigma of [0.005, 0.021, 0.06, 0.1, 0.25]) {
        for (const days of [1, 3, 7, 30, 90, 365]) {
          expect(minMagnitudePct(assetClass, sigma, days)).toBeLessThan(
            maxMagnitudePct(assetClass, days, sigma),
          );
        }
      }
    }
  });

  it('σ를 모르면 상한도 하한과 **같은 폴백으로** 움직인다 — 창이 조용히 닫히지 않게', () => {
    // 예전에는 상한만 고정값으로 빠져나갔다. 폴백이 거칠어지자 하한만 올라가
    // 국내 7일 기준 게시 가능한 창이 2%p까지 좁아졌다
    for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as const) {
      for (const days of [1, 7, 30, 90, 365]) {
        const lo = minMagnitudePct(assetClass, null, days);
        const hi = maxMagnitudePct(assetClass, days, null);
        expect(hi).toBeGreaterThan(lo);
        expect(hi - lo).toBeGreaterThan(lo * 0.2); // 창이 하한의 20%보다는 넓다
      }
    }
  });
});

describe('수익성 가중 w — 크기에 연속 (2026-08-13)', () => {
  it('구간 경계에서 뛰지 않는다 — 여기가 차익이 살던 자리였다', () => {
    // 경계는 F의 1.5 / 2 / 3 / 5배. 예전에는 이 지점에서 w가 0.25씩 계단으로 뛰어
    // 목표를 0.02%p 올리는 것만으로 기대 점수가 14~25% 올랐다
    const F = PROFITABILITY_BASE_PCT.KR_EQUITY;
    for (const b of PROFITABILITY_BOUNDS) {
      const below = magnitudeWeight('KR_EQUITY', F * b - 0.01);
      const above = magnitudeWeight('KR_EQUITY', F * b + 0.01);
      expect(Math.abs(above - below)).toBeLessThan(0.005);
    }
  });

  it('범위는 [1, 2] — 아주 작은 목표와 아주 큰 목표에서 클램프된다', () => {
    expect(magnitudeWeight('KR_EQUITY', 0.5)).toBe(1);
    expect(magnitudeWeight('KR_EQUITY', 1_000)).toBe(2);
    expect(magnitudeWeight('CRYPTO', 1_000)).toBe(2);
  });

  it('크기에 단조 증가한다', () => {
    let prev = 0;
    for (let m = 1; m <= 60; m += 0.5) {
      const w = magnitudeWeight('KR_EQUITY', m);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = w;
    }
  });

  it('자산군 기준 단위 F로 정규화된다 — 같은 배수면 같은 무게', () => {
    expect(magnitudeWeight('KR_EQUITY', 15)).toBeCloseTo(magnitudeWeight('CRYPTO', 30), 12);
  });

  it('별점 환산과 같은 눈금을 쓴다 — 구간 대표 배수의 로그 보간', () => {
    // 구간 5의 대표 배수에서 w가 정확히 2에 닿는다
    const F = PROFITABILITY_BASE_PCT.KR_EQUITY;
    expect(magnitudeWeight('KR_EQUITY', F * PROFITABILITY_PAYOUT_MULTIPLE[5])).toBeCloseTo(2, 10);
    expect(magnitudeWeight('KR_EQUITY', F * PROFITABILITY_PAYOUT_MULTIPLE[1])).toBeCloseTo(1, 10);
  });
});
