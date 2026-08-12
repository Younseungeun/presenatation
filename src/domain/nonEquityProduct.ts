// 주식이 아닌 상장 상품 판별 — 채권·우선주·SPAC·워런트·유닛.
//
// 왜 빼는가: ETF를 뺀 것과 **같은 이유**다. 리포트가 답하는 질문은 "이 회사가 어떻게
// 될 것인가"인데 이것들은 그 질문의 대상이 아니다:
//   · 채권·우선주 — 회사가 아니라 **금리·발행 조건**을 따라 움직인다
//   · SPAC(기업인수목적회사) — 합병 전에는 신탁에 든 현금이라 주가가 사실상 고정이다
//   · 워런트·유닛 — 파생·묶음 상품이라 기초 회사의 성과와 선형 관계가 아니다
//
// 실측이 문제를 드러냈다 (안정성 캘리브레이션, 2026-08-13): "가장 조용한 종목" 상위가
// 전부 이것들이었다 — 새켐 캐피털 일반채권(σ 0.3%), 뱅크오브아메리카 우선주 HH(0.3%),
// 키움제11호스팩(0.3%), 안드레티 애퀴지션 2(0.1%). 구조적으로 안 움직이는 상품이
// **★5(가장 안정적인 20%) 구간을 통째로 차지**해, 눈금이 "주식이 아닌 것들" 기준으로
// 정해지고 있었다.
//
// 이름으로 판별하는 이유는 leveragedProduct와 같다: 마스터에 상품 유형 코드가 없고
// (미국은 증권종류 칸이 주식/ETF만 가른다), 이름은 규제상 상품 성격을 담게 되어 있다.

/** 미국 상장명에 들어가는 비주식 표지 — Security Name은 상품 성격을 반드시 적는다 */
const US_MARKERS = [
  'PREFERRED', // 우선주
  'DEPOSITARY SHARE', // 우선주 예탁증서
  'NOTES', // 채권
  'DEBENTURE',
  'BOND',
  'WARRANT', // 워런트
  ' UNIT', // SPAC 유닛 (앞 공백 — "UNITED"·"UNITY" 오탐 방지)
  'ACQUISITION CORP', // SPAC
  'ACQUISITION COMPANY',
  'TRUST PREFERRED',
  'SUBORDINATED',
  'CONVERTIBLE',
  'RIGHT', // 신주인수권
];

/** 국내 상장명 표지 */
const KR_MARKERS = ['스팩', '기업인수목적', '우선주', '전환사채', '신주인수권'];

/**
 * 국내 우선주는 이름이 아니라 **종목코드 끝자리**로 갈린다 (보통주 0, 우선주 5·7·9 등).
 * 이름에 "우선주"라고 적히지 않는 경우가 많아(예: 삼성전자우) 코드로 함께 본다.
 */
const KR_PREFERRED_CODE = /^\d{5}[^0]$/;

/**
 * 예측 대상이 아닌 상장 상품인가.
 *
 * 지금은 **안정성 눈금 표본**에서 빼는 데 쓴다. 종목 유니버스에서 아예 빼는 것은
 * 게시 가능 종목이 줄어드는 상품 정책 결정이라 따로 판단해야 한다
 * (leveragedProduct와 같은 취급 — 측정에서 먼저 빼고, 정책은 나중에).
 */
export function isNonEquityProduct(name: string, ticker: string): boolean {
  const upper = ` ${name.toUpperCase()} `;
  if (US_MARKERS.some((m) => upper.includes(m))) return true;
  if (KR_MARKERS.some((m) => name.includes(m))) return true;
  // 국내 6자리 코드에서 끝자리가 0이 아니면 우선주 계열이다
  if (/^\d{6}$/.test(ticker) && KR_PREFERRED_CODE.test(ticker)) return true;
  return false;
}
