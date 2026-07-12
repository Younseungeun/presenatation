import type { MarketSnapshot } from './judgment';

// 시세 데이터 공급자 추상화. 소스(공공데이터포털/KIS/코스콤)를 갈아끼울 수 있도록
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
  /** [from, to] 구간(KST, YYYY-MM-DD)의 일별 시세. 거래일만 반환한다. */
  getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]>;
  /** 기준일 시점의 종목 상태 */
  getSecurityStatus(ticker: string, asOf: string): Promise<SecurityStatus>;
}

/** Date → KST YYYY-MM-DD */
export function toKstDateString(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(d);
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
