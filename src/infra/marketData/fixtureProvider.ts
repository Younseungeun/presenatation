import type {
  DailyQuote,
  InstrumentListing,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';

// 개발·테스트용 인메모리 공급자. 시세를 코드로 심어 판정 파이프라인을 검증한다.

export class FixtureMarketDataProvider implements MarketDataProvider {
  readonly sourceId = 'fixture';

  private quotes = new Map<string, DailyQuote[]>();
  private statuses = new Map<string, SecurityStatus>();
  private currentPrices = new Map<string, number>();
  private instruments: InstrumentListing[] = [];

  setInstruments(listings: InstrumentListing[]): this {
    this.instruments = listings;
    return this;
  }

  async listInstruments(): Promise<InstrumentListing[]> {
    return this.instruments;
  }

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

  setCurrentPrice(ticker: string, price: number): this {
    this.currentPrices.set(ticker, price);
    return this;
  }

  /** 명시된 현재가 → 없으면 마지막 일봉 종가 (업비트 현재가 동작 흉내) */
  async getCurrentPrice(ticker: string): Promise<number> {
    const explicit = this.currentPrices.get(ticker);
    if (explicit !== undefined) return explicit;
    const quotes = this.quotes.get(ticker) ?? [];
    const last = [...quotes].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (!last) throw new Error(`현재가 픽스처 없음: ${ticker} (기준가 확정 불가)`);
    return last.close;
  }
}
