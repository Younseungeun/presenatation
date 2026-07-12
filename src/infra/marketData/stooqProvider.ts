import type {
  DailyQuote,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';

// Stooq EOD 어댑터 — US_EQUITY 개발·검증 전용.
// ⚠️ 하비 프로젝트용 무료 소스: 상업 이용 조건 불명확, SLA 없음.
//    실서비스 판정에는 절대 사용하지 말 것 (docs/market-data.md §3 US_EQUITY 단계 표).
// 키 불필요. CSV 형식: Date,Open,High,Low,Close,Volume

const BASE_URL = 'https://stooq.com/q/d/l/';

/** 미국주식 심볼 → Stooq 표기 (AAPL → aapl.us) */
export function toStooqSymbol(ticker: string): string {
  return `${ticker.toLowerCase()}.us`;
}

/** CSV → DailyQuote[] 날짜 오름차순 (순수 함수 — 네트워크 없이 테스트) */
export function parseStooqCsv(csv: string): DailyQuote[] {
  const lines = csv.trim().split('\n');
  // 데이터 없음이면 "No data" 또는 헤더만 반환됨
  if (lines.length < 2 || !lines[0].startsWith('Date,')) return [];

  return lines
    .slice(1)
    .map((line) => line.split(','))
    .filter((cols) => cols.length >= 5)
    .map((cols) => ({
      date: cols[0],
      open: Number(cols[1]),
      high: Number(cols[2]),
      low: Number(cols[3]),
      close: Number(cols[4]),
      volume: Number(cols[5] ?? 0),
    }))
    .filter((q) => !Number.isNaN(q.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export class StooqMarketDataProvider implements MarketDataProvider {
  readonly sourceId = 'stooq-dev-only';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    const params = new URLSearchParams({
      s: toStooqSymbol(ticker),
      d1: from.replaceAll('-', ''),
      d2: to.replaceAll('-', ''),
      i: 'd',
    });
    const res = await this.fetchImpl(`${BASE_URL}?${params}`);
    if (!res.ok) {
      throw new Error(`Stooq HTTP ${res.status}`);
    }
    return parseStooqCsv(await res.text());
  }

  // 종목 상태 데이터 없음 — 개발용이므로 항상 정상. 결측 시 파이프라인이 이월한다.
  async getSecurityStatus(): Promise<SecurityStatus> {
    return { delisted: false, halted: false };
  }
}
