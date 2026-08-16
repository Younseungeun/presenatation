import type { PrismaClient } from '@prisma/client';

// **판정과 돈이 나가는 순간 사이의 최소 간격** (2026-08-15).
//
// ── 되돌리기 도구는 돈이 남아 있을 때만 도구다 ───────────────
// 지난 회차에 일괄 되돌리기(bulkRevertService)를 만들었다. 그런데 그 도구가 실제로
// 쓸모 있는 조건은 하나뿐이다 — **에스크로에 돈이 아직 있을 것.** 정산이 실행돼
// 리서처 잔고로 넘어갔거나 밖으로 나갔으면, 판정을 되돌려도 돌려줄 돈이 없다.
// 되돌리기는 "판정 기록을 지우고 플랫폼이 손실을 떠안는 절차"로 바뀐다.
//
// 지금 구조에서 그 창의 길이는 **운영자가 얼마나 빨리 클릭하느냐**다. 지시서가
// 생기자마자 /admin/settlements 큐의 맨 위(오래된 순)에 앉으므로, 잘못된 배치가
// 만든 정산이 오히려 **가장 먼저 실행된다.** 사고 대응 도구 전체가 운영자의
// 손 빠르기에 걸려 있었다.
//
// ── 한도와 같은 방어선의 다른 축 ─────────────────────────────
// 일일 한도(payoutVelocity)는 **얼마나 나가는가**를 막는다. 쿨다운은 **얼마나 새 것이
// 나가는가**를 막는다. 둘은 서로를 대신하지 못한다:
//
//   · 탈취된 세션이 수동 판정으로 가짜 적중을 만들어 지급까지 밀어붙이는 경로는
//     한도 안쪽 금액이면 그대로 통과한다. 쿨다운이 있으면 **그 판정으로는 오늘
//     한 푼도 못 뺀다** — 24시간 뒤에나 실행 가능해지고, 그 사이 감사 로그 알림이
//     이미 나갔다
//   · 반대로 쿨다운만 있으면 어제 판정 전체를 오늘 한꺼번에 빼는 것은 막지 못한다.
//     그건 한도의 몫이다
//
// ── 왜 예외를 두지 않는가 ────────────────────────────────────
// "확인했으니 지금 실행" 같은 우회 버튼은 두 번째로 눌리는 순간 기본 동작이 된다.
// 그리고 공격자가 가장 먼저 찾는 것도 그 버튼이다. 급한 건은 쿨다운이 아니라
// **CS 환불**(purchaseVoidService)로 처리한다 — 그쪽은 기계 판정이 아니라 사람이
// 특정 구매자에게 내리는 결정이라 "기계가 틀렸을 수 있다"는 전제 자체가 없다.
//
// ── 구매자 약속과의 관계 ─────────────────────────────────────
// 최대 24시간 늦어지는 것은 사실이다. 그래도 두는 이유는 **반대 방향이 되돌릴 수
// 없기 때문**이다 — 잘못된 실패 판정으로 환불이 나가면 구매자에게 "다시 결제해
// 달라"고 할 수 없다. 그리고 14일 상한은 **판정까지**의 약속이고 실행 지연에는
// 애초에 천장이 없었다(사람이 클릭할 때까지다). 없던 바닥을 놓는 것이지 있던
// 천장을 올리는 것이 아니다.

/**
 * 판정 후 이 시간이 지나야 지급·환불을 실행할 수 있다.
 *
 * ── 왜 24시간이 아니라 48인가 (2026-08-15, 외부 검토 반영) ────
 * 처음에는 "판정 배치가 하루 한 번 도니 하루면 된다"는 운영 리듬으로 24를 잡았다.
 * 그 계산에 **사람이 빠져 있었다** — 판정을 아는 경로가 인앱 알림이고, 열어 보기까지
 * 하루가 걸리면 이의를 쓰는 시점에 이미 돈이 나간 뒤다. 24시간은 시스템의 리듬이지
 * 사람의 리듬이 아니다.
 *
 * 48이면 **알림을 못 본 하루**를 흡수하고도 하루가 남는다.
 *
 * ── 왜 이의 제기 기간(14일)에 맞추지 않는가 ──────────────────
 * 검토는 쿨다운과 이의 기간을 같은 절대 시각으로 일치시키라고 했다. 방향은 맞지만
 * **일치의 방법이 문제다** — 지금 이의 기간은 14일이고, 맞추려면 둘 중 하나다:
 *
 *   ① 쿨다운을 14일로 → 정상 정산이 2주 늦는다. 리서처가 떠난다
 *   ② 이의 기간을 48시간으로 → **구매자 권리를 운영 편의로 깎는 것**이다
 *
 * ②를 택하지 않는다. 판정 후 이틀 안에 이의를 못 내면 끝이라는 약관은 소비자
 * 분쟁에서 불리하게 작동하고, 애초에 이 서비스가 파는 것이 "판정을 믿어도 된다"인데
 * 그 판정에 이의할 시간을 이틀로 자르는 것은 상품 자체와 어긋난다.
 *
 * 대신 **두 기간이 다른 것을 인정하고 그 사이를 무엇이 메우는지 정한다**:
 *
 *   0~48시간   → 이의가 들어오면 **되돌린다** (에스크로에 돈이 있다)
 *   48시간~14일 → 이의가 들어오면 **플랫폼이 부담한다** (CS 환불, purchaseVoidService)
 *
 * 뒤쪽은 손실이지만 **유계이고 측정된다**(opsMetrics의 이의율). 열어 두는 대신
 * 크기를 아는 쪽이, 닫아 놓고 소비자 분쟁에서 지는 쪽보다 낫다.
 *
 * @근거 설계 에스크로로 되돌릴 수 있는 창 — 그 뒤는 CS 환불로 플랫폼이 부담한다
 */
export const SETTLEMENT_COOLDOWN_HOURS = 48;

export class SettlementCooldownError extends Error {
  constructor(
    readonly settledAt: Date,
    readonly executableAt: Date,
  ) {
    super(
      `아직 정산 대기 시간입니다 — 판정 ${settledAt.toISOString()}, ` +
        `실행 가능 ${executableAt.toISOString()}.\n` +
        `판정 후 ${SETTLEMENT_COOLDOWN_HOURS}시간은 되돌릴 수 있게 에스크로에 묶어 둡니다. ` +
        `이 건이 잘못됐다고 판단되면 지금이 되돌릴 수 있는 시간입니다 ` +
        `(npm run judgment:bulk-revert 또는 개별 되돌리기).`,
    );
    this.name = 'SettlementCooldownError';
  }
}

/** 이 시각 이전에 판정된 건만 실행할 수 있다 */
export function cooldownCutoff(now = new Date()): Date {
  return new Date(now.getTime() - SETTLEMENT_COOLDOWN_HOURS * 3_600_000);
}

/** 이 정산이 실행 가능해지는 시각 */
export function executableAt(settledAt: Date): Date {
  return new Date(settledAt.getTime() + SETTLEMENT_COOLDOWN_HOURS * 3_600_000);
}

/**
 * 실행해도 되는가 — **아직이면 던진다.**
 *
 * 큐에서 걸러 내는 것과 **별개로** 실행 직전에 한 번 더 본다. 목록 필터는 화면의
 * 편의이고 이것이 집행이다 — API를 직접 부르는 경로(스크립트·자동화·탈취된 세션)는
 * 목록을 거치지 않는다.
 */
export function assertCooldownPassed(settledAt: Date, now = new Date()): void {
  const at = executableAt(settledAt);
  if (at.getTime() > now.getTime()) {
    throw new SettlementCooldownError(settledAt, at);
  }
}

export interface CooldownHold {
  /** 대기 중인 지시서 건수 (지급 + 환불) */
  count: number;
  /** 묶여 있는 금액 합계 */
  amountKrw: number;
  /** 가장 먼저 풀리는 시각 — 없으면 null */
  nextExecutableAt: Date | null;
}

/**
 * 쿨다운에 걸려 큐에 안 뜨는 지시서의 요약.
 *
 * **목록에서 빼면 존재 자체가 안 보인다**는 것이 이 함수가 있는 이유다. 누를 수 없는
 * 버튼을 그리지 않는 것과 "오늘 나갈 돈이 없다"고 착각하게 두는 것은 다른 문제다 —
 * 운영자가 큐가 비었다고 퇴근하면 안 되는 날이 있다.
 */
export async function getCooldownHold(
  prisma: PrismaClient,
  now = new Date(),
): Promise<CooldownHold> {
  const cutoff = cooldownCutoff(now);
  const held = await prisma.settlement.findMany({
    where: {
      settledAt: { gt: cutoff },
      OR: [
        { buyerRefundKrw: { gt: 0 }, refundExecutedAt: null },
        { researcherPayoutKrw: { gt: 0 }, payoutExecutedAt: null },
      ],
    },
    select: {
      settledAt: true,
      buyerRefundKrw: true,
      refundExecutedAt: true,
      researcherPayoutKrw: true,
      payoutExecutedAt: true,
    },
    orderBy: { settledAt: 'asc' },
  });

  let amountKrw = 0;
  for (const s of held) {
    if (s.refundExecutedAt === null) amountKrw += s.buyerRefundKrw;
    if (s.payoutExecutedAt === null) amountKrw += s.researcherPayoutKrw;
  }

  return {
    count: held.length,
    amountKrw,
    nextExecutableAt: held.length > 0 ? executableAt(held[0].settledAt) : null,
  };
}
