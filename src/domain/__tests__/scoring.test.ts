import { describe, expect, it } from 'vitest';
import {
  computeReachScore,
  DISCIPLINE_LADDER,
  disciplineFor,
  honestConfidence,
  lossAmplifier,
  magnitudePctToTargetPrice,
  maxMagnitudePct,
  MIN_MAGNITUDE_PCT,
  noSkillTouchProbability,
  scoreJudgedCard,
  targetPriceToMagnitudePct,
  winAmplifier,
} from '../scoring';

// 점수 모델 v4 (공정배당 이항) — 수학적 성질을 코드로 고정한다.
// 여기 깨지면 등급·정산의 공정성 주장이 통째로 깨지는 것이다.

describe('무정보 도달 확률 p₀', () => {
  it('주식 하한(+5%/30일)은 절반을 살짝 넘는다 — 하한 목표가 "거의 공짜"라는 사실', () => {
    const p = noSkillTouchProbability('UP', 5, 'KR_EQUITY', 30);
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(0.62);
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

  it('코인 하한(10%)과 주식 하한(5%)의 p₀가 비슷하다 — 하한이 변동성에 맞춰 설계된 증거', () => {
    const eq = noSkillTouchProbability('UP', 5, 'KR_EQUITY', 30);
    const cr = noSkillTouchProbability('UP', 10, 'CRYPTO', 30);
    expect(Math.abs(eq - cr)).toBeLessThan(0.05);
  });

  it('극단값은 클램프된다', () => {
    expect(noSkillTouchProbability('UP', 300, 'KR_EQUITY', 7)).toBeGreaterThanOrEqual(0.01);
    expect(noSkillTouchProbability('UP', 5, 'CRYPTO', 365)).toBeLessThanOrEqual(0.95);
  });
});

describe('공정배당 — 무정보 EV ≤ 0 (스팸이 구조적으로 못 번다)', () => {
  // EV₀ = p₀·hit + (1−p₀)·miss = −B·p₀(1−p₀)·c(c−1)/2 — c=1에서만 0
  it('어떤 (크기, 기간, c)를 골라도 무정보 기대 점수는 0 이하다', () => {
    for (const m of [5, 10, 25, 40]) {
      for (const h of [7, 30, 120]) {
        for (const c of [1, 2, 5, 10]) {
          const { p0, score: hit } = computeReachScore('UP', m, c, 'KR_EQUITY', h, true);
          const { score: miss } = computeReachScore('UP', m, c, 'KR_EQUITY', h, false);
          const ev = p0 * hit + (1 - p0) * miss;
          expect(ev, `M=${m} H=${h} c=${c}`).toBeLessThanOrEqual(1e-9);
          if (c > 1) expect(ev).toBeLessThan(0);
        }
      }
    }
  });

  it('c=1의 무정보 EV는 정확히 0 — 공정 배당의 정의', () => {
    const { p0, score: hit } = computeReachScore('UP', 10, 1, 'CRYPTO', 30, true);
    const { score: miss } = computeReachScore('UP', 10, 1, 'CRYPTO', 30, false);
    expect(p0 * hit + (1 - p0) * miss).toBeCloseTo(0, 9);
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

  it('honestConfidence는 배수를 그대로 돌려주고 1~10에 갇힌다', () => {
    expect(honestConfidence(0.5, 0.5)).toBe(1);
    // odds(0.75)=3, odds(0.5)=1 → 3배
    expect(honestConfidence(0.75, 0.5)).toBe(3);
    expect(honestConfidence(0.999, 0.05)).toBe(10);
    expect(honestConfidence(0.01, 0.5)).toBe(1);
  });
});

describe('배당 구조', () => {
  it('적중 = +B·c·(1−p₀), 실패 = −B·c(c+1)/2·p₀', () => {
    const m = 10;
    const c = 4;
    const { p0, score: hit } = computeReachScore('UP', m, c, 'CRYPTO', 30, true);
    const { score: miss } = computeReachScore('UP', m, c, 'CRYPTO', 30, false);
    expect(hit).toBeCloseTo(10 * m * winAmplifier(c) * (1 - p0), 6);
    expect(miss).toBeCloseTo(-10 * m * lossAmplifier(c) * p0, 6);
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
    expect(maxMagnitudePct('KR_EQUITY', 30)).toBeCloseTo(50);
    expect(maxMagnitudePct('KR_EQUITY', 120)).toBeCloseTo(100);
    expect(maxMagnitudePct('CRYPTO', 30)).toBeCloseTo(120);
  });
});

describe('마이너스 점수 규율', () => {
  it('점수가 깊어질수록 최소 신뢰도가 오르고 최하단은 게시 정지', () => {
    expect(disciplineFor(0).minConfidence).toBe(1);
    expect(disciplineFor(-1_000).minConfidence).toBe(2);
    expect(disciplineFor(-3_000).minConfidence).toBe(5);
    expect(disciplineFor(-6_000).minConfidence).toBe(7);
    expect(disciplineFor(-10_000).publishSuspended).toBe(true);
  });

  it('래더가 c≥2를 강제하는 순간 무정보 EV가 음수로 떨어진다 — 규율의 수학적 근거', () => {
    // c=1 은신처(EV=0)는 남지만, 1단 래더(-1,000)가 c=2를 강제하면
    // EV = −B·p₀(1−p₀)·c(c−1)/2 < 0 — 하강이 가속된다
    const { p0, score: hit } = computeReachScore('UP', 5, 2, 'KR_EQUITY', 30, true);
    const { score: miss } = computeReachScore('UP', 5, 2, 'KR_EQUITY', 30, false);
    expect(p0 * hit + (1 - p0) * miss).toBeLessThan(0);
    expect(DISCIPLINE_LADDER.some((r) => r.minConfidence >= 2)).toBe(true);
  });
});

describe('하한 상수의 정합', () => {
  it('MIN_MAGNITUDE_PCT는 자산군마다 정의되어 있다', () => {
    expect(MIN_MAGNITUDE_PCT.KR_EQUITY).toBeGreaterThan(0);
    expect(MIN_MAGNITUDE_PCT.US_EQUITY).toBeGreaterThan(0);
    expect(MIN_MAGNITUDE_PCT.CRYPTO).toBeGreaterThan(0);
  });
});
