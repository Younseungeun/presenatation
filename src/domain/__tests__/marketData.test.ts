import { describe, expect, it } from 'vitest';
import { buildMarketSnapshot, type DailyQuote } from '../marketData';

const NORMAL = { delisted: false, halted: false };

function quote(date: string, over: Partial<DailyQuote> = {}): DailyQuote {
  return { date, open: 100, high: 110, low: 90, close: 105, volume: 1000, ...over };
}

describe('buildMarketSnapshot', () => {
  it('상장폐지 상태가 최우선', () => {
    expect(buildMarketSnapshot([quote('2026-07-01')], { delisted: true, halted: false }, '2026-07-10')).toEqual({
      status: 'DELISTED',
    });
  });

  it('거래정지 상태 반영', () => {
    expect(buildMarketSnapshot([], { delisted: false, halted: true }, '2026-07-10')).toEqual({
      status: 'TRADING_HALT',
    });
  });

  it('종가 극값은 **일봉 종가**로만 집계 — 장중 고가·저가는 판정에 쓰지 않는다', () => {
    // 07-02는 장중 130까지 튀었지만 종가는 106이다.
    // 장중 꼬리가 도달을 만들면 시세를 튀겨 판정을 조작할 수 있으므로 종가만 센다
    const snap = buildMarketSnapshot(
      [
        quote('2026-07-01', { high: 120, low: 95, close: 104 }),
        quote('2026-07-02', { high: 130, low: 85, close: 106 }),
        quote('2026-07-03', { high: 115, low: 100, close: 108 }),
      ],
      NORMAL,
      '2026-07-03',
    );
    expect(snap.maxCloseSincePublish).toBe(108);
    expect(snap.minCloseSincePublish).toBe(104);
    expect(snap.priceAtDeadline).toBe(108);
  });

  it('시한 이후 날짜의 시세는 종가 극값에서도 빠진다', () => {
    const snap = buildMarketSnapshot(
      [quote('2026-07-01', { close: 104 }), quote('2026-07-05', { close: 200 })],
      NORMAL,
      '2026-07-03',
    );
    expect(snap.maxCloseSincePublish).toBe(104);
  });

  it('시한이 휴장일이면 직전 거래일 종가 사용', () => {
    const snap = buildMarketSnapshot(
      [quote('2026-07-02', { close: 111 }), quote('2026-07-03', { close: 112 })],
      NORMAL,
      '2026-07-05', // 일요일 — 시세 없음
    );
    expect(snap.priceAtDeadline).toBe(112);
  });

  it('시세가 전무하면 필드 없이 TRADED — 판정 엔진이 AMBIGUOUS 처리', () => {
    const snap = buildMarketSnapshot([], NORMAL, '2026-07-10');
    expect(snap.status).toBe('TRADED');
    expect(snap.priceAtDeadline).toBeUndefined();
    expect(snap.maxCloseSincePublish).toBeUndefined();
  });
});

