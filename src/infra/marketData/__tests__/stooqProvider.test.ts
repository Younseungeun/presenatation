import { describe, expect, it } from 'vitest';
import { parseStooqCsv, StooqMarketDataProvider, toStooqSymbol } from '../stooqProvider';

describe('toStooqSymbol', () => {
  it('미국 심볼을 소문자 + .us로 변환', () => {
    expect(toStooqSymbol('AAPL')).toBe('aapl.us');
  });
});

describe('parseStooqCsv', () => {
  it('CSV를 DailyQuote 오름차순으로 변환', () => {
    const csv = [
      'Date,Open,High,Low,Close,Volume',
      '2026-07-10,210.0,215.5,208.1,214.2,55000000',
      '2026-07-09,205.0,211.0,204.0,210.0,48000000',
    ].join('\n');
    const quotes = parseStooqCsv(csv);
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

  it('데이터 없음("No data") → 빈 배열', () => {
    expect(parseStooqCsv('No data')).toEqual([]);
  });

  it('헤더만 있는 응답 → 빈 배열', () => {
    expect(parseStooqCsv('Date,Open,High,Low,Close,Volume\n')).toEqual([]);
  });
});

describe('StooqMarketDataProvider.getDailyQuotes', () => {
  it('심볼·기간 파라미터를 Stooq 형식으로 전달', async () => {
    let requested = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      requested = String(url);
      return new Response('Date,Open,High,Low,Close,Volume\n2026-07-10,1,2,0.5,1.5,100', {
        status: 200,
      });
    }) as typeof fetch;

    const provider = new StooqMarketDataProvider(fetchImpl);
    const quotes = await provider.getDailyQuotes('AAPL', '2026-07-01', '2026-07-10');

    expect(quotes).toHaveLength(1);
    expect(requested).toContain('s=aapl.us');
    expect(requested).toContain('d1=20260701');
    expect(requested).toContain('d2=20260710');
  });
});
