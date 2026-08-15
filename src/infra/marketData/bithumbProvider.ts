import type { DailyQuote, MarketDataProvider, SecurityStatus } from '@/domain/marketData';

// 빗썸 공개 시세 어댑터 — **CRYPTO 자산군의 두 번째 증인** (판정 교차검증 전용).
// https://apidocs.bithumb.com/reference/candlestick-rest-api
//
// ── 판정 기준 거래소는 여전히 업비트다 ──────────────────────────
// 약관이 "업비트 KRW 일봉"을 판정 기준으로 명시한다(docs/market-data.md §3). 빗썸이
// 다른 값을 준다고 해서 업비트가 틀린 것이 아니다 — **거래소가 다르면 가격도 원래 다르다.**
// 그래서 이 어댑터는 판정을 대체하지 않고 `domain/crossCheck`의 **결론 대조**에만 쓰인다:
// 두 거래소의 값 차이는 목표선에서 멀면 아무 일도 아니고, 결론을 뒤집는 자리에서만
// 사람을 부른다.
//
// ── 왜 코인만 두 번째 소스가 있는가 ─────────────────────────────
// 계약 없이 지금 붙일 수 있는 것이 이것뿐이기 때문이다. 국내는 공공데이터포털(금융위)이
// 후보지만 상업 이용 조건이 미확인이고(CLAUDE.md §6.5), 미국은 운영 소스 자체가
// 아직 계약 전이다. 인터페이스는 자산군 무관하므로 계약이 열리는 대로 레지스트리에
// 한 줄씩 추가하면 된다.
//
// ⚠ **이 어댑터는 실계정 스모크 테스트 전까지 shadow 모드로만 돈다** (crossCheck.ts).
// 응답 필드 순서를 잘못 읽으면 모든 코인 판정이 불일치로 멈추는데, 그 사고를
// 프로덕션에서 발견하는 것은 너무 비싸다.

const CANDLE_URL = 'https://api.bithumb.com/public/candlestick';

/**
 * 빗썸 일봉 응답 한 줄. **순서가 함정이다** — 업비트·KIS와 달리
 * `[시각, 시가, **종가**, 고가, 저가, 거래량]`으로 종가가 두 번째다.
 * 고가·저가 자리에 종가를 넣는 실수가 조용히 지나가지 않도록 상수로 못 박는다.
 */
const OPEN = 1;
const CLOSE = 2;
const HIGH = 3;
const LOW = 4;
const VOLUME = 5;

interface BithumbCandleResponse {
  status: string;
  data?: (string | number)[][];
  message?: string;
}

/** KST 자정 기준 epoch ms → YYYY-MM-DD (업비트 일봉과 같은 눈금) */
function toKstDate(ms: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date(ms));
}

function num(v: string | number): number {
  return typeof v === 'number' ? v : Number(v);
}

/** 응답 → 일봉 (순수 함수 — 네트워크 없이 테스트한다) */
export function parseBithumbCandles(rows: (string | number)[][]): DailyQuote[] {
  return rows
    .map((r) => ({
      date: toKstDate(num(r[0])),
      open: num(r[OPEN]),
      high: num(r[HIGH]),
      low: num(r[LOW]),
      close: num(r[CLOSE]),
      volume: num(r[VOLUME]),
    }))
    .filter((q) => Number.isFinite(q.close) && q.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 업비트 마켓코드 → 빗썸 심볼. `KRW-BTC` → `BTC_KRW`.
 * 카드에 저장된 티커가 업비트 표기라 여기서 맞춘다 — 두 소스가 서로 다른 표기를
 * 쓰는 것을 호출부가 알 필요는 없다.
 */
export function toBithumbSymbol(upbitMarket: string): string | null {
  const m = /^KRW-([A-Z0-9]+)$/.exec(upbitMarket.trim().toUpperCase());
  return m ? `${m[1]}_KRW` : null;
}

export class BithumbMarketDataProvider implements MarketDataProvider {
  readonly sourceId = 'bithumb';

  async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    const symbol = toBithumbSymbol(ticker);
    // 표기를 못 바꾸면 **조용히 빈 배열을 주지 않는다** — 빈 배열은 "이 구간에 거래가
    // 없다"는 뜻이라 교차검증이 NO_DATA로 넘어가고, 티커 매핑 버그가 영원히 숨는다
    if (!symbol) throw new Error(`빗썸 심볼로 변환할 수 없는 티커: ${ticker}`);

    const res = await fetch(`${CANDLE_URL}/${symbol}/24h`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`빗썸 일봉 조회 실패 (HTTP ${res.status}): ${symbol}`);
    const body = (await res.json()) as BithumbCandleResponse;
    if (body.status !== '0000' || !Array.isArray(body.data)) {
      throw new Error(`빗썸 일봉 응답 오류 (${body.status}): ${body.message ?? symbol}`);
    }
    // 구간 지정 인자가 없어 전체를 받아 자른다 (판정 구간은 최대 365일이라 충분히 덮인다)
    return parseBithumbCandles(body.data).filter((q) => q.date >= from && q.date <= to);
  }

  /**
   * 상태는 답하지 않는다 — **정상으로 지어내지 않기 위해서다.**
   * 교차검증은 상태를 묻지 않고(주 소스 값을 쓴다) 가격만 대조한다. 그런데 이 어댑터가
   * 레지스트리에 그냥 꽂혀 주 소스 자리에 서면, 여기서 `{delisted:false, halted:false}`를
   * 돌려주는 순간 거래지원 종료된 코인이 정상 판정된다. 던지는 편이 안전하다.
   */
  async getSecurityStatus(): Promise<SecurityStatus> {
    throw new Error('빗썸 어댑터는 교차검증 전용이라 종목 상태를 제공하지 않습니다');
  }
}
