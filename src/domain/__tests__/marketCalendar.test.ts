import { describe, expect, it } from 'vitest';
import {
  closeTimeOn,
  coverageEndsIn,
  holidayName,
  LATE_CLOSE_DAYS,
  MARKET_HOLIDAYS,
} from '../marketCalendar';
import { isJustAfterClose, isMarketOpen, isTradingDay } from '../marketHours';
import { planBaseMode } from '../publishReport';

// 휴장일 달력 — 틀리면 판정이 하루 밀리거나(휴일 오등록) 장중에 판정한다(늦은 마감 누락).

describe('휴장일 등록', () => {
  it('국내 추석·한글날은 휴장', () => {
    expect(holidayName('KR_EQUITY', '2026-09-25')).toBe('추석');
    expect(holidayName('KR_EQUITY', '2026-10-09')).toBe('한글날');
  });

  it('미국 콜럼버스의 날·재향군인의 날은 휴장이 아니다 — 주식시장은 정상 개장한다', () => {
    // 연방 공휴일이지만 NYSE·나스닥은 연다(채권시장만 휴장).
    // 휴장으로 넣으면 그날 판정이 통째로 다음 거래일로 밀린다
    expect(holidayName('US_EQUITY', '2026-10-12')).toBeNull();
    expect(holidayName('US_EQUITY', '2026-11-11')).toBeNull();
    expect(holidayName('US_EQUITY', '2026-11-26')).toBe('Thanksgiving Day');
  });

  it('코인은 휴장이 없다', () => {
    expect(holidayName('CRYPTO', '2026-12-25')).toBeNull();
    expect(isTradingDay('CRYPTO', new Date('2026-12-25T00:00:00Z'))).toBe(true);
  });
});

describe('휴장일에는 장이 열리지도, 판정 창구가 열리지도 않는다', () => {
  it('한글날(금) 장중 시각에도 닫혀 있다', () => {
    expect(isMarketOpen('KR_EQUITY', new Date('2026-10-09T02:00:00Z'))).toBe(false); // 11:00 KST
  });

  it('한글날에는 마감 창구가 열리지 않는다 — 그날 종가가 없다', () => {
    expect(isJustAfterClose('KR_EQUITY', new Date('2026-10-09T06:35:00Z'))).toBe(false);
  });

  it('추수감사절 다음날(11/27)은 조기 마감이지만 거래일이라 정규 창구로 판정한다', () => {
    // 조기 마감은 일부러 반영하지 않는다 — 판정을 앞당기면 장중가를 종가로 읽을 위험이
    // 생긴다. 정규 시각(16:05 ET)에는 조기 마감일에도 일봉이 확정되어 있다
    expect(isTradingDay('US_EQUITY', new Date('2026-11-27T18:00:00Z'))).toBe(true);
    expect(isJustAfterClose('US_EQUITY', new Date('2026-11-27T21:10:00Z'))).toBe(true); // 16:10 ET
  });
});

describe('늦은 마감', () => {
  it('지정이 없으면 정규 마감시각', () => {
    expect(closeTimeOn('KR_EQUITY', '2026-08-12', '15:30')).toBe('15:30');
  });

  it('정규보다 이른 값은 무시한다 — 판정을 앞당기는 방향은 받지 않는다', () => {
    LATE_CLOSE_DAYS.KR_EQUITY['2026-12-24'] = { close: '13:00', note: '조기 마감(가정)' };
    expect(closeTimeOn('KR_EQUITY', '2026-12-24', '15:30')).toBe('15:30');
    delete LATE_CLOSE_DAYS.KR_EQUITY['2026-12-24'];
  });

  it('늦은 마감은 반영해 판정 창구를 미룬다 — 안 하면 장중에 판정한다', () => {
    LATE_CLOSE_DAYS.KR_EQUITY['2026-11-19'] = { close: '16:30', note: '수능일(가정)' };
    // 15:35 KST — 평소라면 창구가 열렸을 시각
    expect(isJustAfterClose('KR_EQUITY', new Date('2026-11-19T06:35:00Z'))).toBe(false);
    expect(isMarketOpen('KR_EQUITY', new Date('2026-11-19T07:00:00Z'))).toBe(true); // 16:00 KST
    expect(isJustAfterClose('KR_EQUITY', new Date('2026-11-19T07:40:00Z'))).toBe(true); // 16:40 KST
    delete LATE_CLOSE_DAYS.KR_EQUITY['2026-11-19'];
  });
});

describe('게시 규칙', () => {
  it('휴장일 08:00 이전 게시는 "당일 종가" 창구를 열지 않는다', () => {
    // 한글날 07:00 KST에 시한 3일짜리 단기 카드
    const now = new Date('2026-10-08T22:00:00Z');
    const deadline = new Date('2026-10-12T00:00:00Z');
    expect(planBaseMode('KR_EQUITY', deadline, now).baseMode).toBe('DAY_CLOSE_AT_CLOSE');
  });

  it('평일 08:00 이전이면 종전대로 당일 종가 예측을 허용한다', () => {
    const now = new Date('2026-08-11T22:00:00Z'); // 07:00 KST 화요일
    const deadline = new Date('2026-08-13T00:00:00Z');
    // **소급이 아니라 게시 시점 확정** (2026-08-16) — 직전 거래일 종가는 어제 마감
    // +5분에 이미 확정됐고 KIS가 개장 전에도 그대로 준다(실측). 미루던 이유(금융위
    // D+1 지연)는 2026-08-10 KIS 전환으로 사라졌다
    expect(planBaseMode('KR_EQUITY', deadline, now).baseMode).toBe('PREV_CLOSE_AT_PUBLISH');
  });
});

describe('달력 만료', () => {
  it('범위가 끝나기 전에는 양수, 지나면 음수 — 스케줄러가 이걸로 경고한다', () => {
    expect(coverageEndsIn('KR_EQUITY', '2026-12-01')).toBeGreaterThan(0);
    expect(coverageEndsIn('KR_EQUITY', '2027-01-15')).toBeLessThan(0);
  });

  it('등록된 휴장일은 모두 달력 범위 안에 있다', () => {
    for (const market of ['KR_EQUITY', 'US_EQUITY'] as const) {
      for (const day of Object.keys(MARKET_HOLIDAYS[market])) {
        expect(coverageEndsIn(market, day)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
