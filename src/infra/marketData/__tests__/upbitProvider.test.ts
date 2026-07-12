import { describe, expect, it } from 'vitest';
import { parseUpbitCandles, UpbitMarketDataProvider } from '../upbitProvider';

function candle(dateKst: string, close: number) {
  return {
    market: 'KRW-BTC',
    candle_date_time_kst: `${dateKst}T00:00:00`,
    opening_price: 100_000_000,
    high_price: 105_000_000,
    low_price: 98_000_000,
    trade_price: close,
    candle_acc_trade_volume: 1234.5678,
  };
}

describe('parseUpbitCandles', () => {
  it('응답(최신순)을 날짜 오름차순 DailyQuote로 변환', () => {
    const quotes = parseUpbitCandles([
      candle('2026-07-11', 101_000_000),
      candle('2026-07-10', 99_000_000),
    ]);
    expect(quotes.map((q) => q.date)).toEqual(['2026-07-10', '2026-07-11']);
    expect(quotes[1]).toMatchObject({ close: 101_000_000, high: 105_000_000 });
  });
});

describe('UpbitMarketDataProvider.getDailyQuotes', () => {
  it('to 날짜 캔들 포함, 범위 밖 캔들 제외, market 파라미터 전달', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(
        JSON.stringify([
          candle('2026-07-11', 101_000_000),
          candle('2026-07-10', 99_000_000),
          candle('2026-07-09', 98_000_000), // from 이전 — 제외되어야 함
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new UpbitMarketDataProvider(undefined, fetchImpl);
    const quotes = await provider.getDailyQuotes('KRW-BTC', '2026-07-10', '2026-07-11');

    expect(quotes.map((q) => q.date)).toEqual(['2026-07-10', '2026-07-11']);
    expect(requested[0]).toContain('market=KRW-BTC');
    // to는 exclusive이므로 다음 날 자정 KST가 상한
    expect(decodeURIComponent(requested[0])).toContain('2026-07-12T00:00:00+09:00');
  });

  it('HTTP 오류는 예외', async () => {
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const provider = new UpbitMarketDataProvider(undefined, fetchImpl);
    await expect(provider.getDailyQuotes('KRW-BTC', '2026-07-01', '2026-07-11')).rejects.toThrow(
      /429/,
    );
  });
});
