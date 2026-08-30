import { describe, expect, it } from 'vitest';
import { classifySourceHealth, decideSlowPersistAlert } from '../sourceHealth';

const base = { providerDownCount: 0, emptyRangeBulk: false, hasMore: false, touched: true };

describe('classifySourceHealth — 시세 소스 세 상태', () => {
  it('공급자 응답 없음이면 장애 (지연·정상보다 우선)', () => {
    expect(classifySourceHealth({ ...base, providerDownCount: 3, hasMore: true })).toBe('down');
  });

  it('빈 시세 대량이면 장애', () => {
    expect(classifySourceHealth({ ...base, emptyRangeBulk: true })).toBe('down');
  });

  it('장애는 없고 회차 상한만 걸리면 지연 (소스는 멀쩡)', () => {
    expect(classifySourceHealth({ ...base, hasMore: true })).toBe('slow');
  });

  it('실제로 판정이 돌았고 문제 없으면 정상', () => {
    expect(classifySourceHealth({ ...base, touched: true })).toBe('ok');
  });

  it('이번 회차에 소스와 상호작용이 없으면 null — 기존 상태를 덮지 않는다', () => {
    expect(classifySourceHealth({ ...base, touched: false })).toBeNull();
    // 단 상호작용이 없어도 장애 신호가 있으면 장애로 남긴다
    expect(classifySourceHealth({ ...base, touched: false, providerDownCount: 1 })).toBe('down');
  });
});

describe('decideSlowPersistAlert — 지연 지속 알람 (B)', () => {
  const cfg = { alertAfterMs: 6 * 60 * 60_000, gapResetMs: 12 * 60_000 };
  const H = 3_600_000;

  it('지연이 아니면 상태를 없애고 알리지 않는다', () => {
    const prev = { since: 0, lastSlowAt: 0, lastAlertAt: null };
    expect(decideSlowPersistAlert(prev, false, 5 * H, cfg)).toEqual({ next: null, fire: false });
  });

  it('처음 지연이면 구간을 시작하되 문턱 전이라 안 알린다', () => {
    const { next, fire } = decideSlowPersistAlert(null, true, 1000, cfg);
    expect(fire).toBe(false);
    expect(next).toEqual({ since: 1000, lastSlowAt: 1000, lastAlertAt: null });
  });

  it('같은 구간이 문턱(6시간)에 닿으면 알린다', () => {
    // 2분 주기로 이어진다고 보고, 구간 시작에서 6시간 지난 관측
    const prev = { since: 1000, lastSlowAt: 1000 + 6 * H - 120_000, lastAlertAt: null };
    const now = 1000 + 6 * H;
    const { next, fire } = decideSlowPersistAlert(prev, true, now, cfg);
    expect(fire).toBe(true);
    expect(next!.lastAlertAt).toBe(now);
    expect(next!.since).toBe(1000); // 같은 구간 유지
  });

  it('한 번 알린 뒤에는 다음 6시간까지 다시 안 알린다 (그리고 6시간 뒤 재알림)', () => {
    const alertedAt = 1000 + 6 * H;
    // 알린 직후 곧바로 또 지연이어도 조용하다
    const soon = decideSlowPersistAlert(
      { since: 1000, lastSlowAt: alertedAt, lastAlertAt: alertedAt },
      true,
      alertedAt + 120_000,
      cfg,
    );
    expect(soon.fire).toBe(false);
    // 마지막 알람에서 6시간이 더 지나면 다시 알린다 (코인 24시간 지연이 침묵하지 않게)
    const again = decideSlowPersistAlert(
      { since: 1000, lastSlowAt: alertedAt + 6 * H - 120_000, lastAlertAt: alertedAt },
      true,
      alertedAt + 6 * H,
      cfg,
    );
    expect(again.fire).toBe(true);
  });

  it('오래 끊긴 뒤 지연(장 마감 후 개장)은 새 구간 — 어제 지연으로 즉시 안 알린다', () => {
    // 어제 종가 근처 slow 뒤 17시간 공백, 오늘 개장 첫 slow
    const yesterday = 1000;
    const prev = { since: yesterday, lastSlowAt: yesterday, lastAlertAt: yesterday };
    const now = yesterday + 17 * H; // gapResetMs(12분)를 훨씬 넘음
    const { next, fire } = decideSlowPersistAlert(prev, true, now, cfg);
    expect(fire).toBe(false); // 새 구간이라 다시 6시간을 세야 한다
    expect(next).toEqual({ since: now, lastSlowAt: now, lastAlertAt: null });
  });

  it('회차 몇 번 건너뜀(간격 <12분)은 같은 구간으로 견딘다', () => {
    const prev = { since: 1000, lastSlowAt: 1000, lastAlertAt: null };
    const now = 1000 + 10 * 60_000; // 10분 뒤 (gapReset 12분 이내)
    const { next } = decideSlowPersistAlert(prev, true, now, cfg);
    expect(next!.since).toBe(1000); // 구간 유지 (리셋 안 됨)
  });
});
