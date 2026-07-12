import type {
  DailyQuote,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';

// 개발·테스트용 인메모리 공급자. 시세를 코드로 심어 판정 파이프라인을 검증한다.

export class FixtureMarketDataProvider implements MarketDataProvider {
  readonly sourceId = 'fixture';

  private quotes = new Map<string, DailyQuote[]>();
  private statuses = new Map<string, SecurityStatus>();

  setQuotes(ticker: string, quotes: DailyQuote[]): this {
    this.quotes.set(ticker, quotes);
    return this;
  }

  setStatus(ticker: string, status: SecurityStatus): this {
    this.statuses.set(ticker, status);
    return this;
  }

  async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    return (this.quotes.get(ticker) ?? []).filter((q) => q.date >= from && q.date <= to);
  }

  async getSecurityStatus(ticker: string): Promise<SecurityStatus> {
    return this.statuses.get(ticker) ?? { delisted: false, halted: false };
  }
}
