import type {
  DailyQuote,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';

// 공공데이터포털 금융위원회 주식시세정보 어댑터.
// https://www.data.go.kr/data/15094808/openapi.do
// 데이터는 D+1 영업일 13시 이후 공개 — 판정 배치는 이를 전제로 스케줄링한다 (docs/market-data.md §3).

const BASE_URL =
  'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

/** 금융위 API 응답의 일별 시세 항목 (사용 필드만) */
interface FscPriceItem {
  basDt: string; // 기준일자 YYYYMMDD
  srtnCd: string; // 단축코드
  mkp: string; // 시가
  hipr: string; // 고가
  lopr: string; // 저가
  clpr: string; // 종가
  trqu: string; // 거래량
}

interface FscResponse {
  response?: {
    header?: { resultCode?: string; resultMsg?: string };
    body?: { items?: { item?: FscPriceItem[] | FscPriceItem } };
  };
}

/** YYYYMMDD → YYYY-MM-DD */
function toIsoDate(basDt: string): string {
  return `${basDt.slice(0, 4)}-${basDt.slice(4, 6)}-${basDt.slice(6, 8)}`;
}

/** 응답 JSON → DailyQuote[] (순수 함수 — 네트워크 없이 테스트) */
export function parseFscPriceResponse(json: FscResponse): DailyQuote[] {
  const code = json.response?.header?.resultCode;
  if (code !== undefined && code !== '00') {
    throw new Error(`금융위 시세 API 오류: ${code} ${json.response?.header?.resultMsg ?? ''}`);
  }
  const raw = json.response?.body?.items?.item;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return items
    .map((it) => ({
      date: toIsoDate(it.basDt),
      open: Number(it.mkp),
      high: Number(it.hipr),
      low: Number(it.lopr),
      close: Number(it.clpr),
      volume: Number(it.trqu),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export class FscMarketDataProvider implements MarketDataProvider {
  readonly sourceId = 'fsc-data.go.kr';

  constructor(
    private readonly serviceKey: string,
    /**
     * 종목 상태 조회는 금융위 API가 제공하지 않는다.
     * KRX 상폐·거래정지 목록 배치가 붙기 전까지는 "정상" 고정 —
     * 시세 결측 시 파이프라인이 판정을 이월하므로 오판정으로 이어지지 않는다.
     */
    private readonly statusResolver: (
      ticker: string,
      asOf: string,
    ) => Promise<SecurityStatus> = async () => ({ delisted: false, halted: false }),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    const params = new URLSearchParams({
      serviceKey: this.serviceKey,
      resultType: 'json',
      numOfRows: '500',
      pageNo: '1',
      likeSrtnCd: ticker,
      beginBasDt: from.replaceAll('-', ''),
      endBasDt: to.replaceAll('-', ''),
    });
    const res = await this.fetchImpl(`${BASE_URL}?${params}`);
    if (!res.ok) {
      throw new Error(`금융위 시세 API HTTP ${res.status}`);
    }
    return parseFscPriceResponse((await res.json()) as FscResponse);
  }

  getSecurityStatus(ticker: string, asOf: string): Promise<SecurityStatus> {
    return this.statusResolver(ticker, asOf);
  }
}
