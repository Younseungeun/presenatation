import { describe, expect, it } from 'vitest';
import { CLOSE_GRACE_MIN, isJustAfterClose, isMarketOpen } from '../marketHours';

// 스케줄러가 "언제 돌지"를 정하는 규칙 — 시간대·주말·유예를 고정한다.
// 시각은 UTC로 적고 시장 현지시각으로 해석되는지 본다 (KST=UTC+9, ET=UTC−4 서머타임).

const kst = (iso: string) => new Date(iso); // 주석의 시각은 UTC 기준이다

describe('정규장 개장 판정', () => {
  it('국내는 09:00~15:30 KST — 00:00 UTC(09:00 KST)는 열려 있다', () => {
    expect(isMarketOpen('KR_EQUITY', kst('2026-08-12T00:30:00Z'))).toBe(true); // 09:30 KST
    expect(isMarketOpen('KR_EQUITY', kst('2026-08-12T07:00:00Z'))).toBe(false); // 16:00 KST
    expect(isMarketOpen('KR_EQUITY', kst('2026-08-11T23:00:00Z'))).toBe(false); // 08:00 KST
  });

  it('주말은 닫혀 있다', () => {
    // 2026-08-15는 토요일
    expect(isMarketOpen('KR_EQUITY', kst('2026-08-15T02:00:00Z'))).toBe(false);
  });

  it('코인은 항상 열려 있다 — 주말·새벽 무관', () => {
    expect(isMarketOpen('CRYPTO', kst('2026-08-15T18:00:00Z'))).toBe(true);
  });
});

describe('마감 직후 판정 창구 — 마감 +5분', () => {
  it('국내 15:30 정각에는 아직 아니다 (종가가 잠정일 수 있어 유예를 둔다)', () => {
    expect(isJustAfterClose('KR_EQUITY', kst('2026-08-12T06:30:00Z'))).toBe(false); // 15:30 KST
  });

  it('15:35부터 창구가 열린다', () => {
    expect(isJustAfterClose('KR_EQUITY', kst('2026-08-12T06:35:00Z'))).toBe(true); // 15:35 KST
    expect(CLOSE_GRACE_MIN).toBe(5);
  });

  it('창구는 한 시간 — 스케줄러가 잠깐 죽어도 그날 판정을 놓치지 않는다', () => {
    expect(isJustAfterClose('KR_EQUITY', kst('2026-08-12T07:30:00Z'))).toBe(true); // 16:30 KST
    expect(isJustAfterClose('KR_EQUITY', kst('2026-08-12T07:40:00Z'))).toBe(false); // 16:40 KST
  });

  it('코인은 마감이 없어 이 창구를 쓰지 않는다', () => {
    expect(isJustAfterClose('CRYPTO', kst('2026-08-12T06:35:00Z'))).toBe(false);
  });
});
