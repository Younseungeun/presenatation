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

describe('UpbitMarketDataProvider.getCurrentPrice', () => {
  it('ticker 엔드포인트에서 실시간 체결가 반환', async () => {
    let requested = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      requested = String(url);
      return new Response(JSON.stringify([{ market: 'KRW-BTC', trade_price: 158_500_000 }]), {
        status: 200,
      });
    }) as typeof fetch;

    const provider = new UpbitMarketDataProvider(undefined, fetchImpl);
    await expect(provider.getCurrentPrice('KRW-BTC')).resolves.toBe(158_500_000);
    expect(requested).toContain('/v1/ticker?markets=KRW-BTC');
  });

  it('빈 응답·0원 가격은 예외 (기준가 오염 방지)', async () => {
    const fetchImpl = (async () => new Response('[]', { status: 200 })) as typeof fetch;
    const provider = new UpbitMarketDataProvider(undefined, fetchImpl);
    await expect(provider.getCurrentPrice('KRW-XXX')).rejects.toThrow(/유효하지 않습니다/);
  });
});
