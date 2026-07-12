import type {
  DailyQuote,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';

// 업비트 공개 시세 API 어댑터 — CRYPTO 자산군 주 소스.
// https://docs-e.upbit.com/reference/days
// 인증 불필요(공개 시세), 일봉은 KST 자정 마감. 판정 기준 거래소를 업비트로 고정한다
// (docs/market-data.md §3). 티커는 업비트 마켓코드(KRW-BTC) 표기.

const BASE_URL = 'https://api.upbit.com/v1/candles/days';
const MAX_COUNT_PER_CALL = 200;

/** 업비트 일봉 응답 항목 (사용 필드만) */
interface UpbitCandle {
  market: string;
  candle_date_time_kst: string; // "2026-07-10T00:00:00"
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number; // 종가
  candle_acc_trade_volume: number;
}

/** 응답 → DailyQuote[] 날짜 오름차순 (순수 함수 — 네트워크 없이 테스트) */
export function parseUpbitCandles(candles: UpbitCandle[]): DailyQuote[] {
  return candles
    .map((c) => ({
      date: c.candle_date_time_kst.slice(0, 10),
      open: c.opening_price,
      high: c.high_price,
      low: c.low_price,
      close: c.trade_price,
      volume: c.candle_acc_trade_volume,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export class UpbitMarketDataProvider implements MarketDataProvider {
  readonly sourceId = 'upbit';

  constructor(
    /**
     * 거래지원 종료(상폐) 여부는 업비트 공지 수집 배치에서 주입한다.
     * 붙기 전에는 "정상" 고정 — 시세 결측 시 파이프라인이 이월하므로 오판정 없음.
     */
    private readonly statusResolver: (
      ticker: string,
      asOf: string,
    ) => Promise<SecurityStatus> = async () => ({ delisted: false, halted: false }),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    // 일봉은 to(exclusive)에서 과거 방향으로 count개씩 페이지네이션
    const collected: UpbitCandle[] = [];
    // to 날짜의 캔들까지 포함하려면 다음 날 자정(KST)을 exclusive 상한으로 사용
    let cursor = `${nextDate(to)}T00:00:00+09:00`;

    for (;;) {
      const params = new URLSearchParams({
        market: ticker,
        count: String(MAX_COUNT_PER_CALL),
        to: cursor,
      });
      const res = await this.fetchImpl(`${BASE_URL}?${params}`);
      if (!res.ok) {
        throw new Error(`업비트 시세 API HTTP ${res.status}`);
      }
      const page = (await res.json()) as UpbitCandle[];
      if (page.length === 0) break;
      collected.push(...page);

      const oldest = page[page.length - 1].candle_date_time_kst.slice(0, 10);
      if (oldest <= from || page.length < MAX_COUNT_PER_CALL) break;
      cursor = `${oldest}T00:00:00+09:00`; // exclusive — oldest 이전 캔들부터 다음 페이지
    }

    return parseUpbitCandles(collected).filter((q) => q.date >= from && q.date <= to);
  }

  getSecurityStatus(ticker: string, asOf: string): Promise<SecurityStatus> {
    return this.statusResolver(ticker, asOf);
  }
}

/** YYYY-MM-DD → 다음 날 YYYY-MM-DD (UTC 기준 산술 — 날짜 문자열 연산만) */
function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
