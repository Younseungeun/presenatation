import type { AssetClass } from './constants';

// 거래일 달력 — 휴장일과 특수 마감시각.
//
// 왜 필요한가: 지금까지는 주말만 알았다. 공휴일에도 배치가 시세를 부르고(값이 없어
// 이월된다) 판정 창구가 헛돌았다. 정확성이 깨지지는 않았지만 호출을 버렸다.
//
// **손으로 관리하는 데이터다.** 자동 소스를 붙이지 않은 이유: 공휴일은 1년에 십수 개고
// 정부·거래소 공지로 확정되며, 잘못된 자동 파싱이 조용히 하루를 통째로 건너뛰는 것보다
// 사람이 연 1회 채워 넣는 편이 안전하다. 대신 **범위가 끝나면 경고한다**(coverageEndsIn).

export type Market = Exclude<AssetClass, 'CRYPTO'>;

/**
 * 휴장일 (해당 시장 현지 날짜 → 명칭).
 *
 * 미국: 콜럼버스의 날(10/12)·재향군인의 날(11/11)은 **넣지 않는다.**
 * 연방 공휴일이지만 NYSE·나스닥 주식시장은 정상 개장한다(채권시장만 휴장).
 * 휴장으로 잘못 넣으면 그날 판정이 통째로 다음 거래일로 밀린다.
 */
export const MARKET_HOLIDAYS: Record<Market, Record<string, string>> = {
  KR_EQUITY: {
    '2026-08-17': '광복절 대체공휴일',
    '2026-09-24': '추석 연휴',
    '2026-09-25': '추석',
    '2026-09-26': '추석 연휴', // 토요일과 겹친다 — 명시해 둔다
    '2026-10-05': '개천절 대체공휴일',
    '2026-10-09': '한글날',
    '2026-12-25': '성탄절',
  },
  US_EQUITY: {
    '2026-09-07': 'Labor Day',
    '2026-11-26': 'Thanksgiving Day',
    '2026-12-25': 'Christmas Day',
  },
};

/**
 * 평소보다 **늦게** 닫는 날 (현지 마감시각).
 *
 * 늦은 마감만 다룬다. 이르게 닫는 날(미국 추수감사절 다음날·성탄 전야 13:00 조기 마감)은
 * 일부러 넣지 않는다 — 조기 마감을 반영하면 판정이 **앞당겨지는데**, 날짜가 하나라도
 * 틀리면 장중 가격을 종가로 읽어 되돌릴 수 없는 오판을 낸다. 정규 시각에 판정하면
 * 조기 마감일에도 일봉은 이미 확정되어 있어 결과가 같다. 늦은 마감은 반대로,
 * 반영하지 않으면 **장중에 판정해 버리므로** 반드시 넣어야 한다.
 *
 * 국내 수능일은 통상 1시간 늦게 열고 닫는다 — 날짜가 확정되면 여기 추가한다.
 */
export const LATE_CLOSE_DAYS: Record<Market, Record<string, { close: string; note: string }>> = {
  KR_EQUITY: {},
  US_EQUITY: {},
};

/** 이 달력이 책임지는 구간. 끝나면 그 뒤는 "휴일 없음"으로 동작하므로 갱신해야 한다 */
export const CALENDAR_COVERAGE: Record<Market, { from: string; to: string }> = {
  KR_EQUITY: { from: '2026-08-12', to: '2026-12-31' },
  US_EQUITY: { from: '2026-08-12', to: '2026-12-31' },
};

/** 휴장일이면 명칭, 아니면 null (코인은 언제나 null) */
export function holidayName(assetClass: AssetClass, marketDate: string): string | null {
  if (assetClass === 'CRYPTO') return null;
  return MARKET_HOLIDAYS[assetClass][marketDate] ?? null;
}

/** 그날의 마감시각 (늦은 마감이 지정된 날이면 그 값) */
export function closeTimeOn(assetClass: Market, marketDate: string, regular: string): string {
  const late = LATE_CLOSE_DAYS[assetClass][marketDate];
  // 규정 시각보다 이른 값은 무시한다 — 판정을 앞당기는 방향은 받지 않는다
  return late && late.close > regular ? late.close : regular;
}

/** 달력 만료까지 남은 일수. 음수면 이미 지났다 */
export function coverageEndsIn(assetClass: Market, marketDate: string): number {
  const end = Date.parse(`${CALENDAR_COVERAGE[assetClass].to}T00:00:00Z`);
  return Math.floor((end - Date.parse(`${marketDate}T00:00:00Z`)) / 86_400_000);
}

/**
 * 달력이 책임지는 구간 밖인가 — **그렇다면 판정하면 안 된다.**
 *
 * 만료 30일 전부터 운영자에게 주 1회 알림이 가지만(scripts/runScheduler), 알림은
 * 아무것도 막지 않는다. 사람이 안 채우면 그대로 지나가고, 그때부터 이 달력은
 * **"휴일이 없다"고 답한다** — 설 연휴에 판정을 시도하고, 늦은 마감을 모른 채
 * 장중에 판정한다. 둘 다 조용히 틀리는 방향이다.
 *
 * 그래서 구간 밖에서는 **판정을 이월한다.** 판정이 하루 늦는 것은 되돌릴 수 있지만
 * 잘못된 판정은 정산까지 흘러가 되돌릴 수 없다. 이 도메인의 기본 태도와 같다 —
 * 모르면 지어내지 않고 멈춘다.
 *
 * **뒤쪽(만료)만 본다.** `from`은 이 달력을 쓴 날짜일 뿐이라 그보다 앞선 시한을 가진
 * 카드는 프로덕션에 존재할 수 없고(카드의 시한은 게시일 이후다), 과거 구간을 막으면
 * 실데이터 재현·백필이 통째로 멈춘다(scripts/simRegimeShift 등). 이 장치가 막으려는
 * 것은 **달력이 소진되는 미래** — 사람이 안 채우면 조용히 지나가는 방향이다.
 * ⚠ `from`을 앞으로 당겨 과거 휴일을 지우면 그 구간이 무방비가 된다. 지우지 말 것.
 */
export function isOutsideCalendarCoverage(assetClass: AssetClass, marketDate: string): boolean {
  if (assetClass === 'CRYPTO') return false; // 24시간 거래라 휴장일 개념이 없다
  return marketDate > CALENDAR_COVERAGE[assetClass].to;
}
