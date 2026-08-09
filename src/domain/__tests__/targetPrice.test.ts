import { describe, expect, it } from 'vitest';
import { magnitudePctToTargetPrice, targetPriceToMagnitudePct } from '../scoring';

// 목표가 ↔ 예측 크기(%)는 서로의 역이어야 한다.
// 구매 후 화면이 말하는 목표가와 채점이 쓰는 크기가 갈라지면, 산 사람이 본 주장과
// 실제로 채점된 주장이 다른 것이 된다 — 이 서비스에서 가장 치명적인 종류의 불일치다.

describe('magnitudePctToTargetPrice', () => {
  it('상승은 기준가 위, 하락은 기준가 아래', () => {
    expect(magnitudePctToTargetPrice(100_000, 'UP', 10)).toBeCloseTo(110_000, 6);
    expect(magnitudePctToTargetPrice(100_000, 'DOWN', 10)).toBeCloseTo(90_000, 6);
  });

  it('실제 카드 값 — 198,000원에서 10% 하락이면 178,200원', () => {
    expect(magnitudePctToTargetPrice(198_000, 'DOWN', 10)).toBeCloseTo(178_200, 6);
  });

  it('크기 0이면 기준가 그대로 (경계)', () => {
    expect(magnitudePctToTargetPrice(50_000, 'UP', 0)).toBe(50_000);
  });

  it('유효하지 않은 기준가는 거부한다 — 목표가를 지어내지 않는다', () => {
    expect(() => magnitudePctToTargetPrice(0, 'UP', 10)).toThrow();
    expect(() => magnitudePctToTargetPrice(-1, 'UP', 10)).toThrow();
  });

  it('targetPriceToMagnitudePct와 왕복이 성립한다', () => {
    for (const base of [1_000, 57_800, 198_000, 0.42]) {
      for (const pct of [1, 8, 10, 33.3, 120]) {
        for (const dir of ['UP', 'DOWN'] as const) {
          const target = magnitudePctToTargetPrice(base, dir, pct);
          expect(targetPriceToMagnitudePct(target, base)).toBeCloseTo(pct, 6);
        }
      }
    }
  });
});
