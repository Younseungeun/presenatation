import type { Direction } from './constants';

// 판매 규칙 — "지금 살 수 있는 카드는 광고한 것의 절반 이상이 남아 있다"는 보장.
//
// ── 2026-08-10 재설계 (시뮬레이션: scripts/simSalesBand.ts) ──────────────
//
// 판매가 끝나는 길은 셋뿐이고, 가격 때문에 **영구히** 닫히는 일은 없다:
//  ① 목표 도달 — 일봉 종가가 목표를 넘으면 **판정**이 일어나고(판정 규칙과 같은 사건),
//     판정된 카드는 팔 수 없으므로 판매도 그 순간 끝난다. 별도 마감 규칙이 아니다.
//  ② WINDOW_END — 시간 규칙. 판매 기간 = min(검증기간 × 1/3, 30일).
//     시뮬(scripts/simSalesWindow.ts): 1/3 시점 구매자의 적중 확률이 게시 직후의 ~42%로
//     무너진다. 유지율 곡선이 자산군·기간과 무관해 비율 하나로 전 카드를 덮는다.
//  ③ RESEARCHER — 리서처 자발 단축. 회수 불가(비용을 치르는 정직 신호 — 되돌릴 수
//     있으면 비용이 0이 되어 신호가 죽는다).
//
// 가격의 몫은 **가역적인 판매 중단**이다 (구 BAND_EXIT 영구 마감은 폐지):
//   q = (지금 사서 리포트대로 행동할 때 남은 수익률) ÷ (광고한 목표 수익률)
//   결제 순간 실시간 시세로 q를 재고, q < α 면 그 결제를 막는다. 시세가 돌아오면
//   다시 팔린다 — 순간 꼬리(wick)로 남의 판매를 영구히 죽이는 조작이 성립하지 않는다.
//
// α = 0.5 인 이유 (시뮬, GBM 드리프트 0, 6조합 × 8,000경로):
//   · 소비자 약속이 깔끔하다: "결제가 승인되는 순간, 광고 폭의 절반 이상이 남아 있다"
//   · 경계(q≈0.5)에서 산 사람의 적중 확률은 게시 직후의 1.2~1.6배 — 중단이 막는 것은
//     "못 맞힐 구매"가 아니라 **"광고의 반값도 안 남았는데 제값 주는 구매"**다
//   · 판매 가능일의 11~15%만 잃는다 (α=0.7이면 21~25% + 카드 3분의 2가 중단을 겪는다)
//   · q가 광고 크기로 정규화돼 있어 자산군·크기 무관 상수 하나로 덮인다
//
// 고지 문턱이 비대칭인 이유: 가격이 빠지면 q=(T−S)/S/M 가 분모·분자 양쪽에서 부풀어
// 초과 상태가 흔하다(대칭 τ=0.2면 판매일의 37~50%가 초과 — "고지"가 기본 상태가 된다).
//   · 부족(q < 0.8): 광고 폭을 다 못 채우는 상태 — 판매일의 ~30%, 보장과 짝
//   · 초과(q > 2.0): 반대 방향으로 광고 폭 이상 벌어진 상태 — 판매일의 6~18%.
//     이 상태에서 산 사람의 적중 확률은 게시 직후의 0.33~0.51배다. **경고이지 광고가
//     아니다** — "남은 폭이 크다"가 아니라 "예측이 지금까지 빗나가는 중"이라고 말해야 한다.
//
// 고지·문구는 **비율만 쓴다** — 실제 수치(원·%)를 쓰면 비공개인 목표 수익률이 역산된다.

export const SALES_WINDOW_RATIO = 1 / 3;
export const SALES_WINDOW_MAX_DAYS = 30;

/** 판매 중단선 — 남은 몫이 광고의 절반 밑이면 결제를 막는다 */
export const SUSPEND_ALPHA = 0.5;
/** 부족 고지선 — 남은 몫이 광고의 8할 밑이면 "다 못 챙긴다"를 알린다 */
export const NOTICE_SHORTFALL_Q = 0.8;
/** 초과 고지선 — 반대로 광고 폭 이상 벌어졌으면 "예측이 빗나가는 중"을 경고한다 */
export const NOTICE_EXCESS_Q = 2.0;

export type SalesCloseReason = 'WINDOW_END' | 'RESEARCHER';

export type SalesNoticeState = 'SHORTFALL' | 'NONE' | 'EXCESS';

const DAY_MS = 86_400_000;

/**
 * 지금 사는 사람에게 남은 이동(%) — 현재가에서 목표가까지, 예측 방향 기준.
 * 방향 분기 없이 부호가 맞는다: 하락 카드는 (현재 − 목표)가 잔여이고,
 * 목표를 지나쳤으면 음수가 된다.
 */
export function remainingReturnPct(
  direction: Direction,
  currentPrice: number,
  targetPrice: number,
): number {
  if (currentPrice <= 0) throw new Error(`현재가가 유효하지 않습니다: ${currentPrice}`);
  const sign = direction === 'UP' ? 1 : -1;
  return (sign * (targetPrice - currentPrice) * 100) / currentPrice;
}

/**
 * q — 리포트대로 행동할 때 남은 몫 ÷ 광고한 목표 수익률.
 * 1이면 광고 그대로, 0.5면 절반 남음, 음수면 이미 목표를 지나침(장중),
 * 2면 반대 방향으로 광고 폭만큼 더 벌어진 상태.
 */
export function remainingFraction(
  direction: Direction,
  currentPrice: number,
  targetPrice: number,
  magnitudePct: number,
): number {
  if (magnitudePct <= 0) throw new Error(`광고 수익률이 유효하지 않습니다: ${magnitudePct}`);
  return remainingReturnPct(direction, currentPrice, targetPrice) / magnitudePct;
}

/** 결제 순간의 판매 중단 여부 — 가역. 시세가 구간으로 돌아오면 다시 팔린다 */
export function suspendsPurchase(q: number): boolean {
  return q < SUSPEND_ALPHA;
}

/** 구매 전 고지 상태 — 문구는 비율만 쓴다 (실수치는 목표 역산 통로) */
export function salesNoticeState(q: number): SalesNoticeState {
  if (q < NOTICE_SHORTFALL_Q) return 'SHORTFALL';
  if (q > NOTICE_EXCESS_Q) return 'EXCESS';
  return 'NONE';
}

/** 판매 마감 시각(시간 규칙) = 게시 + min(검증기간 × 1/3, 30일) */
export function salesWindowEnd(publishedAt: Date, deadline: Date): Date {
  const horizon = Math.max(0, deadline.getTime() - publishedAt.getTime());
  const window = Math.min(horizon * SALES_WINDOW_RATIO, SALES_WINDOW_MAX_DAYS * DAY_MS);
  return new Date(publishedAt.getTime() + window);
}

/**
 * 시간 규칙으로 지금 판매 중인가 — **저장된 플래그가 아니라 계산으로 답한다.**
 *
 * 왜 계산인가: 시간 규칙은 게시 순간 확정되는 값(게시일·시한)만으로 완전히 결정된다.
 * 외부 시세도, 사람의 판단도 필요 없다. 그런데 이것을 `Report.salesClosedAt` 플래그로만
 * 판단하면 **배치가 도는 순간까지 답이 틀린다** — 하루 1회 배치라면 마감된 카드가
 * 최대 하루 동안 팔린다. 답을 알 수 있는데 기록되기를 기다릴 이유가 없다.
 *
 * 플래그는 여전히 필요하다(마감 사유·시각의 감사 기록, 리서처 알림). 이 함수는 그것을
 * 대체하는 것이 아니라 **앞에 세우는 가드**다.
 *
 * 값이 없으면 `true`(열림)를 돌려준다 — 게시 전이거나 카드가 없는 리포트라
 * 시간 규칙을 적용할 근거 자체가 없다. 막는 쪽으로 지어내지 않는 것이 이 도메인의
 * 일관된 태도다.
 */
export function isSalesWindowOpen(
  publishedAt: Date | null | undefined,
  deadline: Date | null | undefined,
  now: Date,
): boolean {
  if (!publishedAt || !deadline) return true;
  return now.getTime() < salesWindowEnd(publishedAt, deadline).getTime();
}

/**
 * 구매자 상시 고지 문구 — **비율만 말한다.**
 * 실제 잔여 수치나 목표 원값을 적으면 비공개인 목표가 역산된다(마스킹 붕괴).
 * 고지는 규칙까지만 말하고, 결제 관문의 집행이 그 말을 참으로 만든다.
 */
export function salesGuaranteeText(): string {
  return '판매 중 보장: 결제는 리포트가 광고한 목표 폭의 절반 이상이 남아 있을 때만 승인됩니다. 목표에 도달(일봉 종가 기준)하면 판정과 함께 판매가 종료됩니다.';
}
