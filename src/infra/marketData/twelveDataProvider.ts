import type {
  DailyQuote,
  InstrumentListing,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';

// Twelve Data 어댑터 — US_EQUITY 자산군 주 소스.
// https://twelvedata.com/docs#time-series
// 무료 티어 800콜/일, 8콜/분 — 배치 잡에서 분당 호출 수를 제한한다 (docs/market-data.md §4).

const BASE_URL = 'https://api.twelvedata.com/time_series';
const STOCKS_URL = 'https://api.twelvedata.com/stocks';

/** 종목 목록 대상 거래소 — 미국 정규 거래소만 (OTC 제외) */
const US_EXCHANGES = ['NASDAQ', 'NYSE'] as const;

interface TwelveDataValue {
  datetime: string; // "2026-07-10"
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface TwelveDataResponse {
  status?: string; // "ok" | "error"
  code?: number;
  message?: string;
  values?: TwelveDataValue[];
}

/** 응답 → DailyQuote[] 날짜 오름차순 (순수 함수 — 네트워크 없이 테스트) */
export function parseTwelveDataResponse(json: TwelveDataResponse): DailyQuote[] {
  if (json.status === 'error') {
    // 404 "symbol not found"류도 여기로 — 심볼 오류와 소스 장애를 구분해 메시지에 남긴다
    throw new Error(`Twelve Data API 오류: ${json.code ?? ''} ${json.message ?? ''}`);
  }
  return (json.values ?? [])
    .map((v) => ({
      date: v.datetime.slice(0, 10),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: Number(v.volume),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export class TwelveDataMarketDataProvider implements MarketDataProvider {
  readonly sourceId = 'twelvedata';

  constructor(
    private readonly apiKey: string,
    /**
     * 미국주식 거래정지·상폐 상태는 Twelve Data가 직접 주지 않는다.
     * 별도 상태 배치가 붙기 전에는 "정상" 고정 — 시세 결측 시 파이프라인이 이월.
     */
    private readonly statusResolver: (
      ticker: string,
      asOf: string,
    ) => Promise<SecurityStatus> = async () => ({ delisted: false, halted: false }),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    const params = new URLSearchParams({
      symbol: ticker,
      interval: '1day',
      start_date: from,
      end_date: to,
      timezone: 'America/New_York',
      apikey: this.apiKey,
    });
    const res = await this.fetchImpl(`${BASE_URL}?${params}`);
    if (!res.ok) {
      throw new Error(`Twelve Data API HTTP ${res.status}`);
    }
    return parseTwelveDataResponse((await res.json()) as TwelveDataResponse);
  }

  getSecurityStatus(ticker: string, asOf: string): Promise<SecurityStatus> {
    return this.statusResolver(ticker, asOf);
  }

  /**
   * 상장 종목 전체 — 종목 마스터 동기화용.
   * /stocks 는 참조 데이터 엔드포인트로 무료 티어에서도 호출 가능하다.
   * 클래스 주식 표기는 시세 조회와 동일한 심볼 체계(BRK.B)로 들어온다.
   */
  async listInstruments(): Promise<InstrumentListing[]> {
    const byTicker = new Map<string, InstrumentListing>();
    for (const exchange of US_EXCHANGES) {
      const params = new URLSearchParams({
        exchange,
        country: 'United States',
        apikey: this.apiKey,
      });
      const res = await this.fetchImpl(`${STOCKS_URL}?${params}`);
      if (!res.ok) {
        throw new Error(`Twelve Data 종목 목록 API HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        status?: string;
        code?: number;
        message?: string;
        data?: Array<{ symbol: string; name: string; currency: string }>;
      };
      if (json.status === 'error') {
        throw new Error(`Twelve Data 종목 목록 오류: ${json.code ?? ''} ${json.message ?? ''}`);
      }
      for (const s of json.data ?? []) {
        byTicker.set(s.symbol, { ticker: s.symbol, name: s.name, currency: s.currency || 'USD' });
      }
    }
    return [...byTicker.values()];
  }
}
