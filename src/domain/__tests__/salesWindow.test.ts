import { describe, expect, it } from 'vitest';
import {
  bandFloorPct,
  closesAtDailyClose,
  remainingReturnPct,
  salesCloseLinePct,
  salesSuspendLinePct,
  salesWindowEnd,
  suspendsIntraday,
} from '../salesWindow';

// 판매 마감 규칙 — 소비자에게 한 약속("라벨 최소치의 2/3 보장")이 수식과 일치하는지 고정.

describe('마감선 — 구간 바닥 × 2/3', () => {
  it('구간 바닥이 경계 정의(1.5/2/3/5 × F)와 일치한다', () => {
    expect(bandFloorPct('KR_EQUITY', 1)).toBe(5);
    expect(bandFloorPct('KR_EQUITY', 2)).toBe(7.5);
    expect(bandFloorPct('KR_EQUITY', 3)).toBe(10);
    expect(bandFloorPct('KR_EQUITY', 4)).toBe(15);
    expect(bandFloorPct('KR_EQUITY', 5)).toBe(25);
    expect(bandFloorPct('CRYPTO', 3)).toBe(20);
  });

  it('마감선과 중단선의 서열: 중단선 < 마감선 < 바닥', () => {
    for (const lv of [1, 2, 3, 4, 5] as const) {
      const floor = bandFloorPct('KR_EQUITY', lv);
      const close = salesCloseLinePct('KR_EQUITY', lv);
      const susp = salesSuspendLinePct('KR_EQUITY', lv);
      expect(close).toBeCloseTo((floor * 2) / 3, 10);
      expect(susp).toBeCloseTo(floor / 2, 10);
      expect(susp).toBeLessThan(close);
      expect(close).toBeLessThan(floor);
    }
  });
});

describe('잔여 수익률 — 방향 분기 없이 부호가 맞는다', () => {
  it('상승: 기준 100→목표 112, 현재 106이면 잔여 +5.66%', () => {
    expect(remainingReturnPct('UP', 106, 112)).toBeCloseTo(5.66, 2);
  });

  it('하락: 목표 90, 현재 96이면 잔여 +6.25%', () => {
    expect(remainingReturnPct('DOWN', 96, 90)).toBeCloseTo(6.25, 2);
  });

  it('목표를 지나치면 음수 — 어느 방향이든', () => {
    expect(remainingReturnPct('UP', 120, 112)).toBeLessThan(0);
    expect(remainingReturnPct('DOWN', 85, 90)).toBeLessThan(0);
  });
});

describe('마감·중단 판정', () => {
  // 국내주식 3구간(바닥 10%): 마감선 6.67%, 중단선 5%
  it('종가 잔여 6% → 마감, 7% → 유지', () => {
    expect(closesAtDailyClose('KR_EQUITY', 3, 6)).toBe(true);
    expect(closesAtDailyClose('KR_EQUITY', 3, 7)).toBe(false);
  });

  it('장중 잔여 4.9% → 결제 중단, 5.5% → 통과 (마감선보다 아래에서만 막는다)', () => {
    expect(suspendsIntraday('KR_EQUITY', 3, 4.9)).toBe(true);
    expect(suspendsIntraday('KR_EQUITY', 3, 5.5)).toBe(false);
  });

  it('목표 도달(잔여 ≤ 0)은 어느 선에서든 걸린다', () => {
    expect(closesAtDailyClose('CRYPTO', 5, -1)).toBe(true);
    expect(suspendsIntraday('CRYPTO', 5, -1)).toBe(true);
  });
});

describe('시간 규칙 — min(검증기간×1/3, 30일)', () => {
  const pub = new Date('2026-08-01T00:00:00Z');

  it('30일짜리 카드 → 10일 창', () => {
    const end = salesWindowEnd(pub, new Date('2026-08-31T00:00:00Z'));
    expect(end.toISOString()).toBe('2026-08-11T00:00:00.000Z');
  });

  it('180일짜리 카드 → 60일이 아니라 절대 상한 30일', () => {
    const end = salesWindowEnd(pub, new Date('2027-01-28T00:00:00Z'));
    expect(end.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });

  it('1일짜리 코인 단타 → 8시간 창', () => {
    const end = salesWindowEnd(pub, new Date('2026-08-02T00:00:00Z'));
    expect(end.getTime() - pub.getTime()).toBe(8 * 3600_000);
  });
});
