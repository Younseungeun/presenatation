// 레버리지·인버스 상품 판별.
//
// 왜 필요한가: 안정성 별점의 눈금(domain/stability.ts)은 **보통 종목의 변동성 분포**에
// 맞춰야 한다. 레버리지 ETF·ETN은 설계상 기초자산의 2~3배로 움직이므로, 눈금 산정
// 표본에 섞이면 분포의 꼬리를 혼자 끌고 가 보통주가 전부 "불안정" 쪽으로 밀린다.
// (국내 종목 마스터는 6자리 코드라 ETF·ETN이 아직 걸러지지 않는다 — 별도 백로그.)
//
// 이름 기반 판별인 이유: 종목 마스터에 상품 유형 코드가 없다(마스터 파일의 증권그룹
// 구분코드를 넣기 전까지). 이름은 규제상 상품 성격을 반드시 담게 되어 있어
// ("레버리지", "인버스", "2X") 실무적으로 충분히 잡힌다.

/** 국내 상품명에 들어가는 레버리지·인버스 표지 */
const KR_MARKERS = ['레버리지', '인버스', '곱버스', '2배', '3배'];

/** 배수 표기 — "2X", "3X", "-1X", "ULTRA", "ULTRASHORT" 등 */
const MULTIPLIER_RE = /(^|[^A-Z])(-?[23]X|1\.5X|ULTRA(SHORT|PRO)?|DAILY\s*[23]X)([^A-Z]|$)/;

/** 미국 상장 대표 레버리지·인버스 ETF 티커 (이름이 비거나 축약된 경우의 안전망) */
const US_TICKERS = new Set([
  'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'SPXL', 'SPXS', 'SPXU', 'UPRO', 'SDOW', 'UDOW',
  'TNA', 'TZA', 'FAS', 'FAZ', 'LABU', 'LABD', 'YINN', 'YANG', 'NUGT', 'DUST',
  'JNUG', 'JDST', 'BOIL', 'KOLD', 'UVXY', 'SVXY', 'VIXY', 'TMF', 'TMV', 'TSLL',
  'NVDL', 'NVDU', 'NVDD', 'AAPU', 'MSFU', 'CONL', 'BITX', 'ETHU', 'MSTU', 'MSTZ',
  'QLD', 'SSO', 'SDS', 'QID', 'DXD', 'DOG', 'PSQ', 'SH', 'RWM', 'TWM',
]);

/**
 * 레버리지·인버스 상품인가.
 * 안정성 눈금 산정 표본에서 빼는 데 쓴다 (게시 자체를 막지는 않는다 —
 * 그건 상품 정책의 문제라 별도 결정이 필요하다).
 */
export function isLeveragedProduct(name: string, ticker: string): boolean {
  const upper = ticker.toUpperCase();
  if (US_TICKERS.has(upper)) return true;

  const n = name.toUpperCase();
  if (KR_MARKERS.some((m) => name.includes(m))) return true;
  return MULTIPLIER_RE.test(n);
}
