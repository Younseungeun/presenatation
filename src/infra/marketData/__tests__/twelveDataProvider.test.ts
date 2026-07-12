import { describe, expect, it } from 'vitest';
import { parseTwelveDataResponse } from '../twelveDataProvider';

describe('parseTwelveDataResponse', () => {
  it('정상 응답(최신순)을 날짜 오름차순 DailyQuote로 변환', () => {
    const quotes = parseTwelveDataResponse({
      status: 'ok',
      values: [
        { datetime: '2026-07-10', open: '210.0', high: '215.5', low: '208.1', close: '214.2', volume: '55000000' },
        { datetime: '2026-07-09', open: '205.0', high: '211.0', low: '204.0', close: '210.0', volume: '48000000' },
      ],
    });
    expect(quotes.map((q) => q.date)).toEqual(['2026-07-09', '2026-07-10']);
    expect(quotes[1]).toEqual({
      date: '2026-07-10',
      open: 210.0,
      high: 215.5,
      low: 208.1,
      close: 214.2,
      volume: 55000000,
    });
  });

  it('오류 응답(심볼 없음 등)은 예외', () => {
    expect(() =>
      parseTwelveDataResponse({ status: 'error', code: 404, message: 'symbol not found' }),
    ).toThrow(/404/);
  });

  it('values 누락은 빈 배열', () => {
    expect(parseTwelveDataResponse({ status: 'ok' })).toEqual([]);
  });
});
