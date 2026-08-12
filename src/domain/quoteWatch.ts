import { SUSPEND_ALPHA } from './salesWindow';

// 시세 감시 대상 — **문턱 근처 종목만 장중에 갱신한다.**
//
// 풀어야 했던 문제: "결제해야 막히는" 카드를 목록에서 미리 숨기려면 목록을 그릴 때
// 시세를 알아야 하는데, KIS는 초당 1회라 종목 수만큼 초가 걸린다(20종목=22초).
// 페이지 렌더에서는 불가능하다.
//
// 폐기한 안: 전일 종가로 판단하기. **너무 부정확하다** — 실측(2026-08-12) 결과 하루
// 변동이 q를 0.11~0.33 흔든다. 중단선이 0.5인데 테슬라 카드는 하루에 0.33이 움직여
// 문턱을 그냥 넘나든다.
//
// 채택한 안: **감시 목록**. 문턱 근처 종목만 장중에 짧은 주기로 갱신하고, 나머지는
// 지금처럼 결제 순간에만 실시간으로 본다. 장중 변동은 √시간에 비례하므로 2분 주기면
// q 변동이 0.02 수준이라 문턱 판정에 충분하다(하루 0.33 × √(2/390) ≈ 0.02).
//
// 감시 목록이 비면 어떻게 채우나 — 두 길로 들어온다:
//   ① 매일 판정 배치가 이미 받는 종가로 q를 계산해 등록 (추가 호출 0)
//   ② **결제 전 실시간 호출이 문턱 근처임을 발견하면 그 자리에서 등록** (사용자 확정)
//      감시 밖 종목이 장중에 문턱으로 다가와도, 첫 구매 시도가 그것을 발견해
//      그때부터 감시로 편입된다. 즉 "누군가 사려 한 종목"은 자동으로 관측된다.
//
// 놓쳐도 안전한 이유: 목록은 근사이고 **결제 관문이 진실**이다. 감시에서 빠진 종목이
// 문턱을 넘으면 목록에는 남지만 결제는 지금과 똑같이 막힌다 — 오늘보다 나빠지지 않는다.

/**
 * 감시 편입선 — 남은 몫이 광고 폭의 이만큼 밑이면 장중에 지켜본다.
 * 중단선(0.5)보다 넉넉히 위에 둔 이유: 하루 q 변동이 최대 0.33(실측)이라,
 * 여기 걸린 종목은 하루 사이에 중단선까지 갈 수 있는 거리 안에 있다는 뜻이다.
 */
export const WATCH_ENTER_Q = 1.0;

/**
 * 감시 해제선 — 편입선보다 높게 둔다(이력 현상).
 * 같은 값으로 넣고 빼면 문턱에서 진동하는 종목이 매 회차 등록·해제를 반복한다.
 */
export const WATCH_EXIT_Q = 1.4;

/**
 * 스냅샷이 이보다 낡았으면 **목록에서 숨기지 않는다.**
 * 모르는 상태에서 상품을 지우지 않는다 — 이 도메인의 일관된 태도다
 * (막는 쪽으로 지어내지 않는 priceCache 폴백, 확신 없으면 리베이스하지 않는
 *  corporateAction과 같은 원칙).
 */
export const SNAPSHOT_STALE_MS = 10 * 60_000;

export interface WatchDecision {
  /** 장중 갱신 대상인가 */
  watching: boolean;
  /** 목록에서 감출 것인가 — 스냅샷이 신선하고 실제로 중단 구간일 때만 */
  hideFromMarket: boolean;
}

/**
 * 종목의 최소 q(그 종목 카드들 중 가장 문턱에 가까운 값)로 감시·노출을 정한다.
 * 스냅샷 시각을 함께 받는 이유는 **낡은 값으로 숨기지 않기 위해서**다.
 */
export function decideWatch(input: {
  /** 그 종목의 판매 중 카드들 중 최소 q. 카드가 없으면 null */
  minQ: number | null;
  /** 지금 감시 중인가 (이력 현상 판단에 쓴다) */
  wasWatching: boolean;
  /** 스냅샷 시각 */
  snapshotAt: Date | null;
  now: Date;
}): WatchDecision {
  const { minQ, wasWatching, snapshotAt, now } = input;
  if (minQ === null) return { watching: false, hideFromMarket: false };

  const watching = wasWatching ? minQ < WATCH_EXIT_Q : minQ < WATCH_ENTER_Q;
  const fresh = snapshotAt !== null && now.getTime() - snapshotAt.getTime() < SNAPSHOT_STALE_MS;
  return { watching, hideFromMarket: fresh && minQ < SUSPEND_ALPHA };
}

/** 갱신 우선순위 — 문턱에 가까울수록 먼저. 예산이 모자라도 중요한 종목부터 신선해진다 */
export function watchPriority(minQ: number): number {
  return Math.abs(minQ - SUSPEND_ALPHA);
}
