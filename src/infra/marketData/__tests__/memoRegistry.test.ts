import { describe, expect, it } from 'vitest';
import type { DailyQuote, MarketDataProvider, SecurityStatus } from '@/domain/marketData';
import { memoizeRegistry } from '../memoRegistry';

// 종목 단위 조회 — 같은 종목을 몇 번 물어도 공급자 호출은 한 번이어야 한다.

function q(date: string, close: number): DailyQuote {
  return { date, open: close, high: close, low: close, close, volume: 1 };
}

class CountingProvider implements MarketDataProvider {
  readonly sourceId = 'counting';
  quoteCalls: { ticker: string; from: string; to: string }[] = [];
  statusCalls = 0;
  private readonly all: DailyQuote[] = [
    q('2026-07-01', 100), q('2026-07-05', 105), q('2026-07-10', 110), q('2026-07-15', 115),
  ];
  async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    this.quoteCalls.push({ ticker, from, to });
    return this.all.filter((x) => x.date >= from && x.date <= to);
  }
  async getSecurityStatus(): Promise<SecurityStatus> {
    this.statusCalls++;
    return { delisted: false, halted: false };
  }
}

describe('memoizeRegistry', () => {
  it('같은 종목·같은 구간은 한 번만 부른다', async () => {
    const src = new CountingProvider();
    const p = memoizeRegistry({ CRYPTO: src }).CRYPTO!;
    await p.getDailyQuotes('AAA', '2026-07-01', '2026-07-15');
    await p.getDailyQuotes('AAA', '2026-07-01', '2026-07-15');
    await p.getDailyQuotes('AAA', '2026-07-01', '2026-07-15');
    expect(src.quoteCalls).toHaveLength(1);
  });

  it('이미 받은 구간 안이면 잘라서 준다 — 다시 부르지 않는다', async () => {
    const src = new CountingProvider();
    const p = memoizeRegistry({ CRYPTO: src }).CRYPTO!;
    await p.getDailyQuotes('AAA', '2026-07-01', '2026-07-15');
    const inner = await p.getDailyQuotes('AAA', '2026-07-05', '2026-07-10');
    expect(src.quoteCalls).toHaveLength(1);
    expect(inner.map((x) => x.date)).toEqual(['2026-07-05', '2026-07-10']);
  });

  it('구간이 모자라면 합집합으로 한 번 더 받고 그 뒤로는 다시 안 부른다', async () => {
    const src = new CountingProvider();
    const p = memoizeRegistry({ CRYPTO: src }).CRYPTO!;
    await p.getDailyQuotes('AAA', '2026-07-05', '2026-07-10');
    await p.getDailyQuotes('AAA', '2026-07-01', '2026-07-15'); // 넓어짐 → 재조회
    expect(src.quoteCalls).toHaveLength(2);
    expect(src.quoteCalls[1]).toEqual({ ticker: 'AAA', from: '2026-07-01', to: '2026-07-15' });

    await p.getDailyQuotes('AAA', '2026-07-01', '2026-07-15');
    await p.getDailyQuotes('AAA', '2026-07-05', '2026-07-10');
    expect(src.quoteCalls).toHaveLength(2);
  });

  it('종목이 다르면 따로 부른다', async () => {
    const src = new CountingProvider();
    const p = memoizeRegistry({ CRYPTO: src }).CRYPTO!;
    await p.getDailyQuotes('AAA', '2026-07-01', '2026-07-15');
    await p.getDailyQuotes('BBB', '2026-07-01', '2026-07-15');
    expect(src.quoteCalls.map((c) => c.ticker)).toEqual(['AAA', 'BBB']);
  });

  it('종목 상태도 같은 기준일이면 한 번만 부른다', async () => {
    const src = new CountingProvider();
    const p = memoizeRegistry({ CRYPTO: src }).CRYPTO!;
    await p.getSecurityStatus('AAA', '2026-07-15');
    await p.getSecurityStatus('AAA', '2026-07-15');
    expect(src.statusCalls).toBe(1);
  });
});
