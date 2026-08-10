import type { AssetClass, Direction } from './constants';
import { PROFITABILITY_BOUNDS, type ProfitabilityLevel } from './profitability';
import { MIN_MAGNITUDE_PCT } from './scoring';

// 판매 마감 규칙 — "판매 중인 카드는 광고된 것의 일정 몫이 항상 남아 있다"는 보장.
//
// 마감 사유는 셋이고, 각각 근거가 다르다:
//  ① WINDOW_END — 시간 규칙. 판매 기간 = min(검증기간 × 1/3, 30일).
//     비율은 시뮬레이션(scripts/simSalesWindow.ts)으로 정했다: 가격 규칙이 열어 둔
//     카드라도 기간의 1/3이 지나면 그때 산 구매자의 적중 확률이 게시 직후의 ~42%,
//     절반을 넘기면 25% 밑으로 무너진다. 유지율 곡선이 자산군·기간과 무관하게 같아
//     비율 하나로 전 카드를 덮는다. 절대 상한 30일은 논지 신선도에 대한 판단이다
//     (분석이 낡는 속도는 가격 모델로 흉내 낼 수 없다) — 운영 데이터로 조정.
//  ② BAND_EXIT — 가격 규칙. 잔여 수익률이 수익성 구간 바닥 × 2/3 밑으로 내려간
//     **종가**가 찍히면 마감. 구매자는 목표 원값을 못 보고 구간(별점)만 보므로,
//     보장도 구간 기준이다: "라벨이 약속한 최소치의 2/3는 항상 남아 있다."
//     2/3라는 선의 근거는 시뮬레이션(scripts 참조 + 대화 기록): 구간 바닥을 그대로
//     마감선으로 쓰면 바닥에 붙은 목표가 +1.8% 움직임에도 마감돼 카드 44%가
//     진행 10%도 못 팔고 죽는다. 표시 경계는 스팸 억제·역산 방지에 묶여 있어
//     옮길 수 없고, 마감선을 바닥 아래에 긋는 것이 유일한 구조적 해법이다.
//  ③ (예정) RESEARCHER — 리서처 자발 단축. 회수 불가. 촉매형 리포트의 평판 방어이자
//     비용을 치르는 정직 신호. 필드 하나짜리라 수요가 확인되면 붙인다.
//
// 장중에는 마감하지 않되 **1/2선**을 순간이라도 뚫으면 결제를 즉시 중단한다(SUSPENDED).
// 피해자는 구매하는 순간에 생기므로 검사도 결제 관문에서 한다. 중단은 마감이 아니다 —
// 그날 종가가 2/3선 밑이면 마감 확정, 위로 돌아오면 해제된다. 순간 꼬리(wick) 하나로
// 판매가 영구히 죽으면 시세를 튀겨 남의 판매를 끄는 조작 통로가 되기 때문이다.
// "재개 금지"는 확정 마감에만 적용된다.
//
// 기준가가 아직 없는 카드(국내주식 소급 확정 대기)는 잔여 수익률을 계산할 수 없어
// ②·중단 검사가 쉰다 — 기준가가 채워지는 순간부터 작동한다. ①은 항상 돈다.

export const SALES_WINDOW_RATIO = 1 / 3;
export const SALES_WINDOW_MAX_DAYS = 30;
/** 종가 마감선 = 구간 바닥 × 2/3 */
export const SALES_CLOSE_LINE_RATIO = 2 / 3;
/** 장중 결제 중단선 = 구간 바닥 × 1/2 */
export const SALES_SUSPEND_LINE_RATIO = 1 / 2;

export type SalesCloseReason = 'WINDOW_END' | 'BAND_EXIT';

const DAY_MS = 86_400_000;

/** 수익성 구간의 바닥(%) — 구간 1의 바닥은 크기 하한 F 그 자체다 */
export function bandFloorPct(assetClass: AssetClass, level: ProfitabilityLevel): number {
  const f = MIN_MAGNITUDE_PCT[assetClass];
  return level === 1 ? f : f * PROFITABILITY_BOUNDS[level - 2];
}

/** 종가 마감선(%) — 잔여 수익률이 이 밑의 종가를 찍으면 판매 마감 */
export function salesCloseLinePct(assetClass: AssetClass, level: ProfitabilityLevel): number {
  return bandFloorPct(assetClass, level) * SALES_CLOSE_LINE_RATIO;
}

/** 장중 중단선(%) — 결제 순간 잔여가 이 밑이면 결제를 막는다 */
export function salesSuspendLinePct(assetClass: AssetClass, level: ProfitabilityLevel): number {
  return bandFloorPct(assetClass, level) * SALES_SUSPEND_LINE_RATIO;
}

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
 * 플래그는 여전히 필요하다(마감 사유·시각의 감사 기록, 리서처 알림, BAND_EXIT는 종가를
 * 기다려야 하므로 계산이 불가능). 이 함수는 그것을 대체하는 것이 아니라 **앞에 세우는
 * 가드**다: 계산으로 닫히면 즉시 닫히고, 배치는 그 사실을 기록하러 뒤따라온다.
 *
 * 값이 없으면 `true`(열림)를 돌려준다 — 게시 전이거나 카드가 없는 리포트라
 * 시간 규칙을 적용할 근거 자체가 없다. 막는 쪽으로 지어내지 않는 것이 이 도메인의
 * 일관된 태도다(장중 중단 검사도 시세가 없으면 통과시킨다).
 */
export function isSalesWindowOpen(
  publishedAt: Date | null | undefined,
  deadline: Date | null | undefined,
  now: Date,
): boolean {
  if (!publishedAt || !deadline) return true;
  return now.getTime() < salesWindowEnd(publishedAt, deadline).getTime();
}

/** 종가 기준 마감 여부 — ② BAND_EXIT */
export function closesAtDailyClose(
  assetClass: AssetClass,
  level: ProfitabilityLevel,
  remainingPct: number,
): boolean {
  return remainingPct < salesCloseLinePct(assetClass, level);
}

/** 장중 결제 중단 여부 — 마감이 아니라 그 순간의 차단. 종가가 확정하거나 해제한다 */
export function suspendsIntraday(
  assetClass: AssetClass,
  level: ProfitabilityLevel,
  remainingPct: number,
): boolean {
  return remainingPct < salesSuspendLinePct(assetClass, level);
}

/**
 * 구매자 고지 문구 — **공개 정보(구간)에서만 유도한다.**
 * 실제 잔여 수치를 적으면 시세와 대조해 종목이 역산되므로(마스킹 붕괴),
 * 고지는 보장선까지만 말하고 집행이 그 말을 참으로 만든다.
 */
export function salesGuaranteeText(assetClass: AssetClass, level: ProfitabilityLevel): string {
  const floor = bandFloorPct(assetClass, level);
  const line = salesCloseLinePct(assetClass, level);
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  return `판매 중 보장: 목표까지 남은 폭이 이 구간 최소치(${fmt(floor)}%)의 2/3인 ${fmt(line)}% 밑으로 내려가면 판매가 자동 마감됩니다. 지금 사는 카드에는 광고된 수익 폭의 3분의 2 이상이 남아 있습니다.`;
}
