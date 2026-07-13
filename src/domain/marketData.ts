import type { AssetClass } from './constants';
import type { MarketSnapshot } from './judgment';

// 시세 데이터 공급자 추상화. 자산군별 소스(금융위/Twelve Data/업비트)를 갈아끼울 수 있도록
// 판정 파이프라인은 이 인터페이스에만 의존한다. 설계: docs/market-data.md

/** 일별 시세 1건. date는 KST 기준 YYYY-MM-DD */
export interface DailyQuote {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SecurityStatus {
  /** 상장폐지 여부 */
  delisted: boolean;
  /** 거래정지 추정 여부 (레코드 부재 휴리스틱 또는 명시 데이터) */
  halted: boolean;
}

export interface MarketDataProvider {
  /** 소스 식별자 — 감사 스냅샷에 기록 */
  readonly sourceId: string;
  /** [from, to] 구간(YYYY-MM-DD, 자산군 시간대)의 일별 시세. 거래일만 반환한다. */
  getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]>;
  /** 기준일 시점의 종목 상태 */
  getSecurityStatus(ticker: string, asOf: string): Promise<SecurityStatus>;
  /**
   * 실시간 현재가 (지원 소스만). 게시 시점 기준가 확정에 사용 —
   * 실시간 기준가가 있는 자산군은 단기(1일~) 예측을 허용할 수 있다 (publishReport.ts).
   */
  getCurrentPrice?(ticker: string): Promise<number>;
}

// 자산군별 거래일 기준 시간대. 판정 날짜 환산의 단일 기준 (docs/market-data.md §1)
// 크립토는 24/7이지만 업비트 KST 일봉을 판정 기준으로 약관에 명시한다.
export const MARKET_TIMEZONE: Record<AssetClass, string> = {
  KR_EQUITY: 'Asia/Seoul',
  US_EQUITY: 'America/New_York',
  CRYPTO: 'Asia/Seoul',
};

/** Date → 해당 자산군 거래일 기준 YYYY-MM-DD */
export function toMarketDateString(d: Date, assetClass: AssetClass): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: MARKET_TIMEZONE[assetClass] }).format(d);
}

/** Date → KST YYYY-MM-DD */
export function toKstDateString(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(d);
}

/** 특정 시장 시간대의 시각·요일·날짜 (컷오프·기준일 판단용) */
export function marketClock(
  d: Date,
  timeZone: string,
): { time: string; weekday: string; date: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
    date: new Intl.DateTimeFormat('sv-SE', { timeZone }).format(d),
  };
}

/** 'YYYY-MM-DD' → 다음 날 'YYYY-MM-DD' */
export function nextDateString(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 자산군 → 공급자 매핑. 배치 잡이 구성해 파이프라인에 넘긴다. */
export type ProviderRegistry = Partial<Record<AssetClass, MarketDataProvider>>;

export function resolveProvider(
  registry: ProviderRegistry,
  assetClass: AssetClass,
): MarketDataProvider {
  const provider = registry[assetClass];
  if (!provider) {
    throw new Error(`${assetClass} 자산군의 시세 공급자가 등록되지 않았습니다`);
  }
  return provider;
}

/**
 * 일별 시세 + 종목 상태 → 판정 엔진 입력 스냅샷 (순수 함수).
 * - 고저가: 게시~시한 거래일 전체 기준
 * - 시한 종가: 시한 당일, 휴장이면 직전 거래일 종가 (약관 명시 규칙)
 * - 시세가 한 건도 없으면 필드를 비워 판정 엔진이 AMBIGUOUS 처리하게 한다
 */
export function buildMarketSnapshot(
  quotes: DailyQuote[],
  status: SecurityStatus,
  deadlineDate: string,
): MarketSnapshot {
  if (status.delisted) return { status: 'DELISTED' };
  if (status.halted) return { status: 'TRADING_HALT' };

  const inRange = [...quotes].sort((a, b) => a.date.localeCompare(b.date));
  if (inRange.length === 0) return { status: 'TRADED' }; // 필드 결측 → judge()가 AMBIGUOUS 처리

  const upToDeadline = inRange.filter((q) => q.date <= deadlineDate);
  const lastQuote = upToDeadline[upToDeadline.length - 1];

  return {
    status: 'TRADED',
    highSincePublish: Math.max(...inRange.map((q) => q.high)),
    lowSincePublish: Math.min(...inRange.map((q) => q.low)),
    priceAtDeadline: lastQuote?.close,
  };
}
