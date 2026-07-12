import type {
  DailyQuote,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';

// Twelve Data 어댑터 — US_EQUITY 자산군 주 소스.
// https://twelvedata.com/docs#time-series
// 무료 티어 800콜/일, 8콜/분 — 배치 잡에서 분당 호출 수를 제한한다 (docs/market-data.md §4).

const BASE_URL = 'https://api.twelvedata.com/time_series';

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
}
