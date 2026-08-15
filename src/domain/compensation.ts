import { settle } from './settlement';

// 플랫폼 귀책 보상 — **순수 함수.** DB도 API도 모른다.
//
// 판정을 못 해 카드가 전액 환불로 닫히면 구매자는 돈을 돌려받지만 **리서처는 대금도
// 점수도 못 받는다.** 판매는 실제로 일어났고 콘텐츠는 이미 전달됐는데, 판정을 못 한
// 것은 우리 사정이다. 그 몫을 플랫폼 자본으로 메운다.
//
// ── 사후에 결과를 판정하지 않는다 ───────────────────────────────
// "그 카드가 맞았을 것 같다"를 사람이 보고 지급하는 구조는 절대 만들지 않는다.
// 그러면 운영자가 "맞았다"고 판단할 때 플랫폼 돈이 나가게 되어, 판정 중립성이
// 정확히 우리가 파는 상품(자동 판정)의 심장부에서 깨진다. 보는 것은 결과가 아니라
// **귀책**뿐이다 — "왜 못 쟀는가"에는 답이 있고 "맞았을까"에는 없다.

/**
 * 왜 판정을 못 했나 — **전부 플랫폼 쪽 사유다.**
 *
 * 종목 사정(상장폐지·거래정지)이나 리서처 사정(강제 철회)으로 닫힌 카드는 여기 없다.
 * 그런 건은 보상 지시서를 **만들지 않는다** — `EXCLUDED` 행을 남기는 안도 있었지만,
 * 정상적인 판정 불가마다 죽은 행이 하나씩 쌓여 큐 길이가 사고 규모를 못 말하게 된다.
 */
export const COMPENSATION_CAUSES = {
  /** 교차 검증 불일치로 우리가 자동 판정을 멈춰 둔 사이 시한이 지났다 */
  SYSTEM_PAUSE: '자동 판정 정지 중 상한 도달',
  /** 사람이 판정하도록 큐에 올려 뒀는데 아무도 손대지 않았다 */
  MANUAL_QUEUE: '수동 판정 큐 방치',
  /** 우리 코드가 예외로 죽어 판정이 실패했다 */
  SYSTEM_ERROR: '판정 오류',
  /**
   * 시세를 못 구했다 — **귀책이 확정되지 않은 유일한 칸이다.**
   *
   * 우리 피드 장애(DATA-A)일 수도, 그 종목의 거래정지·유동성 고갈(DATA-B)일 수도 있다.
   * 판정 시점의 상태 신호로 가르려 했으나 **신호 조회 자체가 실패하는 경우**가 남고,
   * 그때 "모르면 우리 귀책"으로 기울이면 **신호가 자주 실패하는 종목일수록 보상이 자주
   * 나간다.** 정보 부재가 돈이 나가는 사유가 되는 구조라 그대로 둘 수 없다.
   * → 기우는 방향을 **지급이 아니라 큐 등재**로 바꿨다. 사람이 거래소 공지를 보고 정한다
   */
  DATA_UNKNOWN: '시세 미확보 (귀책 미확정)',
} as const;

export type CompensationCause = keyof typeof COMPENSATION_CAUSES;

export const COMPENSATION_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'EXCLUDED',
  'EXECUTED',
] as const;
export type CompensationStatus = (typeof COMPENSATION_STATUSES)[number];

/**
 * 판정 레코드의 `dataSource`에서 귀책을 읽는다 — 없으면 null(보상 대상 아님).
 *
 * 새 문자열을 여기 매핑하지 않으면 **조용히 보상이 안 나간다.** 그래서 접두사가 아니라
 * 전체 문자열로 맞춘다 — 오타나 새 사유가 `hard-cap:*` 뭉치에 섞여 통과하는 것보다
 * 매핑에서 빠져 눈에 띄는 편이 낫다.
 */
export function causeFromDataSource(dataSource: string): CompensationCause | null {
  switch (dataSource) {
    case 'hard-cap:paused':
      return 'SYSTEM_PAUSE';
    case 'hard-cap:manual-only':
      return 'MANUAL_QUEUE';
    case 'hard-cap:error':
      return 'SYSTEM_ERROR';
    case 'hard-cap':
      return 'DATA_UNKNOWN';
    default:
      return null;
  }
}

/**
 * 보상액 = **적중했다면 받았을 금액**(판매 대금 − 수수료).
 *
 * `settle`을 그대로 부르는 것이 핵심이다. 여기에 `amount - amount*bp/10000`을 손으로
 * 적으면 반올림 규칙 하나만 달라져도 정산과 보상이 갈라지고, 갈라진 사실은 아무도
 * 모른 채 원 단위로 조용히 쌓인다.
 *
 * ⚠ 선결제 비율은 보지 않는다 — 선결제분은 실패 판정에서도 리서처에게 가는 몫이라
 * 이미 Settlement이 처리했다. 여기서 다시 세면 그만큼 두 번 준다.
 */
export function compensationAmountKrw(input: { amountKrw: number; feeRateBp: number }): number {
  return settle({
    amountKrw: input.amountKrw,
    feeRateBp: input.feeRateBp,
    prepaymentRatio: 0,
    outcome: 'HIT',
  }).researcherPayoutKrw;
}

/**
 * 이 구매가 보상 대상인가.
 *
 * **차지백·CS 무효화 건은 뺀다.** 그 돈은 애초에 우리에게 없거나 거래 자체가 없던
 * 것이 되었으므로, 판매가 일어났다는 보상의 전제가 성립하지 않는다. 판정 불가 환불로
 * 닫힌 정상 구매(`REFUNDED`)와 아직 갈리기 전(`HELD`)만 남긴다.
 */
export function isCompensable(purchase: { escrowStatus: string; amountKrw: number }): boolean {
  if (purchase.amountKrw <= 0) return false;
  return purchase.escrowStatus === 'HELD' || purchase.escrowStatus === 'REFUNDED';
}
