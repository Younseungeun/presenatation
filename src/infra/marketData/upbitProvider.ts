import type {
  DailyQuote,
  InstrumentListing,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';

// 업비트 공개 시세 API 어댑터 — CRYPTO 자산군 주 소스.
// https://docs-e.upbit.com/reference/days
// 인증 불필요(공개 시세), 일봉은 KST 자정 마감. 판정 기준 거래소를 업비트로 고정한다
// (docs/market-data.md §3). 티커는 업비트 마켓코드(KRW-BTC) 표기.

const BASE_URL = 'https://api.upbit.com/v1/candles/days';
const TICKER_URL = 'https://api.upbit.com/v1/ticker';
const MARKET_ALL_URL = 'https://api.upbit.com/v1/market/all';
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

/** 업비트 market/all 응답 항목 (사용 필드만) */
interface UpbitMarket {
  market: string; // "KRW-BTC"
  korean_name: string;
  /** 현행 응답(isDetails=true): 유의 종목 지정 + 주의 사유별 플래그 */
  market_event?: {
    warning?: boolean;
    caution?: Record<string, boolean>;
  };
  /** 구 응답 호환: "NONE" | "CAUTION" */
  market_warning?: string;
}

/** 주의 사유 코드 → 표시 문구 */
const CAUTION_LABEL: Record<string, string> = {
  PRICE_FLUCTUATIONS: '가격 급등락',
  TRADING_VOLUME_SOARING: '거래량 급등',
  DEPOSIT_AMOUNT_SOARING: '입금량 급등',
  GLOBAL_PRICE_DIFFERENCES: '가격 차이',
  CONCENTRATION_OF_SMALL_ACCOUNTS: '소수 계정 집중',
};

/** market_event → 위험 신호. 업비트는 유의 종목 지정을 목록 API에 함께 준다 */
function toRiskSignal(m: UpbitMarket): InstrumentListing['risk'] {
  if (m.market_event?.warning) {
    return { warning: true, note: '업비트 유의 종목 지정' };
  }
  const causes = Object.entries(m.market_event?.caution ?? {})
    .filter(([, on]) => on)
    .map(([code]) => CAUTION_LABEL[code] ?? code);
  if (causes.length > 0) {
    return { caution: true, note: `업비트 주의 종목 (${causes.join('·')})` };
  }
  if (m.market_warning && m.market_warning !== 'NONE') {
    return { caution: true, note: '업비트 주의 종목' };
  }
  return undefined;
}

/** market/all 응답 → KRW 마켓 종목 목록 (순수 함수 — 네트워크 없이 테스트) */
export function parseUpbitMarkets(markets: UpbitMarket[]): InstrumentListing[] {
  return markets
    .filter((m) => m.market.startsWith('KRW-'))
    .map((m) => ({
      ticker: m.market,
      name: m.korean_name,
      currency: 'KRW',
      risk: toRiskSignal(m),
    }));
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

  /** 거래 지원 중인 KRW 마켓 전체 — 종목 마스터 동기화용 */
  async listInstruments(): Promise<InstrumentListing[]> {
    // isDetails=true라야 시장 경보(market_event)가 함께 온다 — 위험 종목 선별의 원천
    const res = await this.fetchImpl(`${MARKET_ALL_URL}?isDetails=true`);
    if (!res.ok) {
      throw new Error(`업비트 마켓 목록 API HTTP ${res.status}`);
    }
    return parseUpbitMarkets((await res.json()) as UpbitMarket[]);
  }

  /** 실시간 현재가 — 코인 게시 시점 기준가 확정용 (단타 예측의 조작 방지 핵심) */
  /**
   * 여러 마켓을 **한 응답으로** 받는다 — `markets=A,B,C`.
   * 감시 갱신에서 코인은 종목이 몇 개든 호출 한 번으로 끝난다(무료·제한 느슨).
   * KIS 주식은 종목당 1.1초 직렬인 것과 대비되는 구조적 차이라 따로 쓴다.
   */
  async getCurrentPrices(tickers: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tickers.length === 0) return out;
    const res = await this.fetchImpl(`${TICKER_URL}?markets=${encodeURIComponent(tickers.join(','))}`);
    if (!res.ok) throw new Error(`업비트 현재가 API HTTP ${res.status}`);
    const body = (await res.json()) as Array<{ market: string; trade_price: number }>;
    for (const row of body) {
      if (Number.isFinite(row.trade_price) && row.trade_price > 0) {
        out.set(row.market, row.trade_price);
      }
    }
    return out;
  }

  async getCurrentPrice(ticker: string): Promise<number> {
    const res = await this.fetchImpl(`${TICKER_URL}?markets=${encodeURIComponent(ticker)}`);
    if (!res.ok) {
      throw new Error(`업비트 현재가 API HTTP ${res.status}`);
    }
    const body = (await res.json()) as Array<{ trade_price: number }>;
    const price = body[0]?.trade_price;
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`업비트 현재가 응답이 유효하지 않습니다: ${ticker}`);
    }
    return price;
  }
}

/** YYYY-MM-DD → 다음 날 YYYY-MM-DD (UTC 기준 산술 — 날짜 문자열 연산만) */
function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
