// 어떤 운영자 행위에 2인 승인이 필요한가 — **순수 규칙** (2026-08-16 검토 2차 Q3).
//
// ── 왜 접근 제어만으로는 부족한가 ──────────────────────────────
// 운영자에게 패스키를 강제하고 최근성을 요구하는 것은 **들어오는 것**을 막는다.
// 그런데 운영자 계정 탈취의 피해는 "들어온 뒤"에 생기고, **악의를 품은 내부자**는
// 정당하게 들어온다. 둘 다 접근 제어로는 못 막는다.
//
// 그래서 실행 자체를 나눈다: **요청하는 사람과 승인하는 사람이 달라야 한다.**
//
// ── 전부에 걸지는 않는다 ──────────────────────────────────────
// 모든 지급에 2인을 요구하면 운영이 멈춘다. 하루 수십 건의 소액 정산까지 두 사람이
// 붙으면, 사람들은 곧 "승인 눌러 달라"는 부탁을 습관처럼 주고받게 되고 **승인이
// 형식이 되는 순간 2인 승인은 장식**이다. 그래서 두 가지에만 건다:
//
//   ① 동결 해제 — 빈도가 낮고, **방어를 스스로 여는 행위**다. 금액과 무관하게 항상
//   ② 큰 금액의 지급 — 문턱 위만. 소액 일상 정산은 한 사람이 계속 처리한다
//   ③ 판정 이의 인정 — **사람이 데이터의 판정을 뒤집는 결정**이다 (2026-08-16 검토 3차).
//      판정은 돈이 흐를 방향을 정하는 원천이라, 내부자가 구매자와 공모해 적중을
//      실패로 뒤집으면 환불이라는 형태로 돈이 샌다. 기각은 걸지 않는다 — 기각은
//      데이터의 판정을 **유지**하는 쪽이라 사람의 손이 새로 들어가지 않는다
//   ④ 기계 판정 이력이 없는 카드의 수동 판정 (2026-08-16 검토 4차 Q1) — 시세 결측·
//      신규 상장으로 **기계의 1차 판정 없이** 수동 큐에 온 카드는 운영자가 넣는 숫자가
//      곧 원천 데이터다. 여기가 조작되면 앞선 모든 방어가 무력해진다. 반대로 되돌리기를
//      거쳐 온 카드(묘비 있음)는 걸지 않는다 — 그 길목(이의 인정)에 이미 2인이 섰고,
//      사고 복구의 대량 수동 판정을 두 배로 느리게 만들 뿐이다
//
// ── 운영자가 1명이면 이 표는 교착이다 ─────────────────────────
// 그래서 **운영자 계정 2개 확보가 출시 요건**이다 (두 번째는 금고 속 콜드 기기여도
// 된다). 1인 예외 경로를 코드에 넣지 않는 이유: "24시간 뒤 단독 실행" 같은 우회로는
// 공격자에게 "계정 하나만 뚫고 기다리면 된다"를 상시 열어 주는 것이다

export const APPROVAL_ACTIONS = [
  'PAYOUT_UNFREEZE',
  'LARGE_PAYOUT',
  'DISPUTE_UPHOLD',
  'FIRST_MANUAL_JUDGMENT',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * 승인 요청·승인서의 수명 (2026-08-16 검토 4차 Q3).
 *
 * 만료가 없으면 반년 전에 올라간 동결 해제 요청을 오늘 승인하고 쓸 수 있다 —
 * 승인의 전제(그때의 사유)는 낡았는데 승인서만 살아 있는 것이다. 동결 해제·이의 인정
 * 모두 "지금의 판단"이 필요한 행위라, 사흘 넘게 방치된 요청은 사유부터 다시 쓰는 것이
 * 맞다. "승인 시 사유 재확인" 방식은 관성적 승인(습관적 클릭)을 못 막아 채택하지 않았다.
 *
 * **승인된 뒤에도 같은 수명이 흐른다** — 검토는 대기(PENDING)의 만료만 말했지만,
 * 승인만 받아 두고 반년 뒤에 소비되는 승인서는 같은 위험의 더 나쁜 형태다.
 *
 * @근거 설계 사흘 넘게 방치된 판단은 다시 내려야 한다 (검토 4차 확정, 72h)
 */
export const APPROVAL_TTL_HOURS = 72;

/** 이 시각 기준으로 낡은 요청/승인서인가 — 대기는 요청 시각, 승인은 승인 시각부터 센다 */
export function isApprovalStale(
  row: { status: ApprovalStatus; requestedAt: Date; decidedAt: Date | null },
  now: Date,
): boolean {
  const cutoff = now.getTime() - APPROVAL_TTL_HOURS * 3_600_000;
  if (row.status === 'PENDING') return row.requestedAt.getTime() < cutoff;
  if (row.status === 'APPROVED') return (row.decidedAt ?? row.requestedAt).getTime() < cutoff;
  return false;
}

/**
 * 2인 승인이 붙는 지급 금액 문턱.
 *
 * 카드 가격이 5천~5만원이고 정산은 그 묶음이라, 일상적인 지급은 대부분 수십만원
 * 단위다. 500만원은 **평소에는 안 걸리고 이상한 날에만 걸리는** 자리다 —
 * 일일 출금 한도(1,000만원)의 절반이라 하루에 두 번 이상 걸리지도 않는다.
 *
 * 낮추면 승인이 일상이 되어 형식으로 전락하고, 높이면 걸려야 할 건이 빠져나간다.
 *
 * @근거 설계 평소에는 안 걸리고 이상한 날에만 걸리는 자리 — 일일 한도의 절반
 */
export const DUAL_APPROVAL_THRESHOLD_KRW = 5_000_000;

/** 이 지급에 2인 승인이 필요한가 */
export function requiresDualApproval(amountKrw: number): boolean {
  return amountKrw >= DUAL_APPROVAL_THRESHOLD_KRW;
}

export const APPROVAL_ACTION_LABEL: Record<ApprovalAction, string> = {
  PAYOUT_UNFREEZE: '정산 동결 해제',
  LARGE_PAYOUT: '고액 지급 실행',
  DISPUTE_UPHOLD: '판정 이의 인정 (판정 뒤집기)',
  FIRST_MANUAL_JUDGMENT: '기계 판정 없는 수동 판정',
};

/**
 * 승인할 수 있는가 — **요청자는 자기 요청을 승인하지 못한다.**
 *
 * 이 한 줄이 2인 승인의 전부다. 여기를 통과시키면 표만 남고 방어는 사라진다.
 * 순수 함수로 떼어 둔 이유도 그것이다 — 이 규칙이 어디서 어떻게 적용되는지
 * 한 곳에서 읽히고, 시험이 직접 겨눌 수 있어야 한다.
 */
export function canApprove(input: {
  requestedBy: string;
  approverUserId: string;
  status: ApprovalStatus;
}): { ok: true } | { ok: false; reason: string } {
  if (input.status === 'EXPIRED') {
    return {
      ok: false,
      reason: `요청 후 ${APPROVAL_TTL_HOURS}시간이 지나 만료됐습니다 — 사유부터 다시 써서 새로 요청해야 합니다`,
    };
  }
  if (input.status !== 'PENDING') {
    return { ok: false, reason: `이미 처리된 요청입니다 (${input.status})` };
  }
  if (input.requestedBy === input.approverUserId) {
    return { ok: false, reason: '요청한 사람은 승인할 수 없습니다 — 다른 운영자가 승인해야 합니다' };
  }
  return { ok: true };
}
