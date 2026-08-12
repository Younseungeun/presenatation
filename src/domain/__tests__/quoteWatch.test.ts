import { describe, expect, it } from 'vitest';
import {
  decideWatch,
  SNAPSHOT_STALE_MS,
  watchPriority,
  WATCH_EXIT_STREAK,
  WATCH_ENTER_Q,
  WATCH_EXIT_Q,
} from '../quoteWatch';
import { SUSPEND_ALPHA } from '../salesWindow';

// 감시 목록 — 문턱 근처만 장중에 본다. 여기서 고정할 것은 두 가지다:
//   ① 편입·해제가 진동하지 않는다 (이력 현상)
//   ② **모르면 숨기지 않는다** — 낡은 스냅샷으로 상품을 지우지 않는다

const NOW = new Date('2026-08-12T05:00:00Z');
const fresh = new Date(NOW.getTime() - 60_000);
const stale = new Date(NOW.getTime() - SNAPSHOT_STALE_MS - 1);

describe('감시 편입·해제', () => {
  it('문턱 근처면 편입한다', () => {
    expect(decideWatch({ minQ: 0.9, wasWatching: false, snapshotAt: fresh, now: NOW }).watching).toBe(true);
  });

  it('멀면 편입하지 않는다 — 장중에 부를 이유가 없다', () => {
    expect(decideWatch({ minQ: 1.2, wasWatching: false, snapshotAt: fresh, now: NOW }).watching).toBe(false);
  });

  it('한 번 들어오면 편입선보다 넉넉히 멀어져야 풀린다 (진동 방지)', () => {
    // 편입선(1.0)과 해제선(1.4) 사이에서는 상태가 유지된다
    const between = 1.2;
    expect(decideWatch({ minQ: between, wasWatching: true, snapshotAt: fresh, now: NOW }).watching).toBe(true);
    expect(decideWatch({ minQ: between, wasWatching: false, snapshotAt: fresh, now: NOW }).watching).toBe(false);
    expect(WATCH_EXIT_Q).toBeGreaterThan(WATCH_ENTER_Q);
  });

  it('해제선을 넘어도 **한 번으로는 안 풀린다** — 튐 한 번에 감시가 꺼지면 안 된다', () => {
    const first = decideWatch({ minQ: 1.5, wasWatching: true, exitStreak: 0, snapshotAt: fresh, now: NOW });
    expect(first.watching).toBe(true);
    expect(first.exitStreak).toBe(1);
  });

  it('연속 3회면 해제한다', () => {
    let streak = 0;
    let watching = true;
    for (let i = 0; i < WATCH_EXIT_STREAK; i++) {
      const d = decideWatch({ minQ: 1.5, wasWatching: watching, exitStreak: streak, snapshotAt: fresh, now: NOW });
      streak = d.exitStreak;
      watching = d.watching;
    }
    expect(watching).toBe(false);
  });

  it('중간에 다시 문턱 권역으로 오면 연속 기록이 리셋된다', () => {
    const a = decideWatch({ minQ: 1.5, wasWatching: true, exitStreak: 1, snapshotAt: fresh, now: NOW });
    expect(a.exitStreak).toBe(2);
    const b = decideWatch({ minQ: 1.1, wasWatching: true, exitStreak: a.exitStreak, snapshotAt: fresh, now: NOW });
    expect(b.exitStreak).toBe(0);
    expect(b.watching).toBe(true);
  });

  it('**장 마감 종가**에서 해제선 위면 한 번으로 해제 — 다음 장까지 값이 안 변한다', () => {
    const d = decideWatch({
      minQ: 1.5,
      wasWatching: true,
      exitStreak: 0,
      atClose: true,
      snapshotAt: fresh,
      now: NOW,
    });
    expect(d.watching).toBe(false);
  });

  it('판매 중 카드가 없으면 **즉시** 해제한다 — 시세와 무관한 사실이다', () => {
    const d = decideWatch({ minQ: null, wasWatching: true, exitStreak: 2, snapshotAt: fresh, now: NOW });
    expect(d.watching).toBe(false);
    expect(d.exitStreak).toBe(0);
    expect(d.hideFromMarket).toBe(false);
  });
});

describe('목록에서 감추는 조건 — 모르면 감추지 않는다', () => {
  it('신선한 스냅샷이 중단 구간을 가리키면 감춘다', () => {
    expect(
      decideWatch({ minQ: SUSPEND_ALPHA - 0.01, wasWatching: true, snapshotAt: fresh, now: NOW })
        .hideFromMarket,
    ).toBe(true);
  });

  it('**낡은 스냅샷으로는 감추지 않는다** — 결제 관문이 실시간으로 최종 판단한다', () => {
    expect(
      decideWatch({ minQ: 0.1, wasWatching: true, snapshotAt: stale, now: NOW }).hideFromMarket,
    ).toBe(false);
  });

  it('스냅샷이 아예 없으면 감추지 않는다', () => {
    expect(
      decideWatch({ minQ: 0.1, wasWatching: false, snapshotAt: null, now: NOW }).hideFromMarket,
    ).toBe(false);
  });

  it('중단선 위면 신선해도 감추지 않는다', () => {
    expect(
      decideWatch({ minQ: SUSPEND_ALPHA + 0.01, wasWatching: true, snapshotAt: fresh, now: NOW })
        .hideFromMarket,
    ).toBe(false);
  });
});

describe('갱신 우선순위', () => {
  it('문턱에 가까울수록 먼저 — 예산이 모자라도 중요한 종목부터 신선해진다', () => {
    expect(watchPriority(0.52)).toBeLessThan(watchPriority(0.9));
    expect(watchPriority(0.48)).toBeLessThan(watchPriority(0.2));
  });
});
