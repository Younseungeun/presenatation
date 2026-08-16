import type { AssetClass } from './constants';
import { closeTimeOn, holidayName } from './marketCalendar';
import { marketClock, MARKET_TIMEZONE } from './marketData';

// 시장 시간 — **배치를 언제 돌릴지**의 단일 기준.
//
// 왜 필요한가: 지금까지 배치는 사람이 손으로 돌렸고 시장 시간을 몰랐다. 그래서
//  · 장이 닫힌 새벽에도 국내 시세를 부르고(값은 안 변하는데 호출·토큰만 쓴다)
//  · 판정은 "언젠가" 돌아 마감 직후 결과를 볼 수 없었다
// 자동화의 뼈대라 도메인에 둔다 — 스케줄러와 배치가 같은 답을 봐야 한다.

/** 정규장 시간 (해당 시장 현지시각) — 거래소가 정한 값이라 고를 것이 없다 */
export const MARKET_SESSION: Record<Exclude<AssetClass, 'CRYPTO'>, { open: string; close: string }> =
  {
    KR_EQUITY: { open: '09:00', close: '15:30' },
    US_EQUITY: { open: '09:30', close: '16:00' },
  };

/**
 * 마감 후 판정까지의 유예 (분) — 사용자 확정: **장 마감 5분 후로 통일**.
 * 마감 정각에 부르면 그날 일봉이 아직 없거나 잠정치일 수 있다. 5분을 두고,
 * 그래도 당일 봉이 없으면 판정하지 않고 이월한다(배치가 그렇게 동작한다).
 *
 * @근거 설계 마감 정각의 일봉은 없거나 잠정치다 — 사용자 확정으로 5분 통일
 */
export const CLOSE_GRACE_MIN = 5;

function isWeekend(weekday: string): boolean {
  return weekday === 'Sat' || weekday === 'Sun';
}

/** 그 시장이 오늘 여는 날인가 — 주말·휴장일 (코인은 언제나 true) */
export function isTradingDay(assetClass: AssetClass, now: Date): boolean {
  if (assetClass === 'CRYPTO') return true;
  const clock = marketClock(now, MARKET_TIMEZONE[assetClass]);
  return !isWeekend(clock.weekday) && holidayName(assetClass, clock.date) === null;
}

/** 지금 정규장이 열려 있나. 코인은 항상 true */
export function isMarketOpen(assetClass: AssetClass, now: Date): boolean {
  if (assetClass === 'CRYPTO') return true;
  const session = MARKET_SESSION[assetClass];
  const clock = marketClock(now, MARKET_TIMEZONE[assetClass]);
  if (!isTradingDay(assetClass, now)) return false;
  return clock.time >= session.open && clock.time <= closeTimeOn(assetClass, clock.date, session.close);
}

/**
 * 지금이 "마감 직후 판정 창구"인가 — 마감 + 유예부터 그 뒤 한 시간까지.
 * 창구를 넓게 잡는 이유: 스케줄러가 잠깐 죽었다 살아나도 그날 판정을 놓치지 않게.
 * (판정 자체가 멱등이라 창구 안에서 여러 번 돌아도 결과가 같다)
 */
export function isJustAfterClose(assetClass: AssetClass, now: Date, windowMin = 60): boolean {
  if (assetClass === 'CRYPTO') return false;
  const clock = marketClock(now, MARKET_TIMEZONE[assetClass]);
  // 휴장일에는 그날 종가 자체가 없다 — 창구를 열면 배치가 헛돌며 호출만 쓴다
  if (!isTradingDay(assetClass, now)) return false;
  const regular = MARKET_SESSION[assetClass].close;
  const [h, m] = closeTimeOn(assetClass, clock.date, regular).split(':').map(Number);
  const closeMin = h * 60 + m + CLOSE_GRACE_MIN;
  const [nh, nm] = clock.time.split(':').map(Number);
  const nowMin = nh * 60 + nm;
  return nowMin >= closeMin && nowMin < closeMin + windowMin;
}

/** 그 시장의 오늘 거래일 문자열 (판정이 "오늘 종가"를 확인할 때 쓴다) */
export function marketToday(assetClass: AssetClass, now: Date): string {
  return marketClock(now, MARKET_TIMEZONE[assetClass]).date;
}
