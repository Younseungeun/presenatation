import type { PrismaClient } from '@prisma/client';
import { notifyOperators } from './opsAlert';
import { cancelTossPayment, TossPaymentError } from './tossPayments';

// 정산 실행 콘솔 (운영자): 판정이 만든 환불·지급 지시서를 실행하고 기록한다.
// "지시서 → 실행 기록" 구조는 그대로 두고 실행 주체만 바뀐다 —
// **PG 취소는 이제 이 코드가 직접 부른다**(executeRefund). 계좌이체·리서처 지급은 아직 사람이 한다.

export const REFUND_METHODS = ['PG_CANCEL', 'BANK_TRANSFER'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** 토스 콘솔·구매자 카드 명세서에 그대로 남는 취소 사유 */
function refundReason(outcome: string, amountKrw: number): string {
  const what =
    outcome === 'UNDECIDABLE'
      ? '판정 불가에 따른 전액 환불'
      : '예측 실패에 따른 성과 연동분 환불';
  return `인투빌 ${what} (${amountKrw.toLocaleString()}원)`.slice(0, 200);
}

export class SettlementOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementOpsError';
  }
}

const PENDING_INCLUDE = {
  purchase: {
    include: {
      buyer: { select: { email: true, penName: true } },
      report: {
        select: {
          id: true,
          title: true,
          researcherId: true,
          researcher: {
            select: { userId: true, user: { select: { email: true, penName: true } } },
          },
        },
      },
    },
  },
} as const;

/**
 * 미실행 환불 지시서 — 오래된 순 (PG 취소 기한 관리)
 *
 * 끝나지 않은 시도(PENDING)를 함께 싣는다. **화면은 그게 있으면 "새로 실행"을 막고
 * "재시도"만 내보내야 한다** — 새 실행은 새 멱등키로 나가 두 번 빠질 수 있다.
 */
export function getPendingRefunds(prisma: PrismaClient) {
  return prisma.settlement.findMany({
    where: { buyerRefundKrw: { gt: 0 }, refundExecutedAt: null },
    include: {
      ...PENDING_INCLUDE,
      refundAttempts: { where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { settledAt: 'asc' },
  });
}

/** 미실행 리서처 지급 지시서 — 오래된 순 */
export function getPendingPayouts(prisma: PrismaClient) {
  return prisma.settlement.findMany({
    where: { researcherPayoutKrw: { gt: 0 }, payoutExecutedAt: null },
    include: PENDING_INCLUDE,
    orderBy: { settledAt: 'asc' },
  });
}

/**
 * 환불 실행 + 구매자 알림. 이미 실행된 건은 거부 (이중 지급 방지)
 *
 * `PG_CANCEL`이면 **여기서 실제로 토스 취소 API를 부른다.** 실패(MISS)는 선결제분을
 * 빼고 성과 연동분만 돌려주므로 부분 취소가 기본이라, 지시서의 금액을 그대로 넘긴다.
 * `BANK_TRANSFER`는 여전히 사람이 은행에서 보내고 여기에는 기록만 남긴다
 * (PG 취소 기한을 넘겼거나 결제 키가 없는 옛 구매의 폴백).
 */
export async function executeRefund(
  prisma: PrismaClient,
  input: {
    settlementId: string;
    operatorUserId: string;
    method: RefundMethod;
    /**
     * 은행 이체 참조번호 — `BANK_TRANSFER`에 **필수**.
     *
     * 계좌이체에는 멱등키가 없다. PG 취소는 같은 키로 다시 불러도 한 번만 나가지만,
     * 사람이 은행 앱에서 보내는 돈은 시스템이 막을 방법이 없다 — 재시도 버튼을 보고
     * "안 나갔구나" 하고 한 번 더 보내면 그대로 두 번 나간다. 시스템 바깥에서 일어난
     * 현금 이동을 안으로 증명하는 유일한 수단이 이 번호이고, **입력을 요구하는 것
     * 자체가 운영자를 은행 앱으로 되돌려 보낸다**(거기서 이미 보낸 이체가 보인다).
     */
    bankReference?: string;
  },
  now = new Date(),
) {
  const s = await prisma.settlement.findUnique({
    where: { id: input.settlementId },
    include: PENDING_INCLUDE,
  });
  if (!s) throw new SettlementOpsError('정산 건을 찾을 수 없습니다');
  if (s.buyerRefundKrw <= 0) throw new SettlementOpsError('환불액이 없는 정산 건입니다');
  if (s.refundExecutedAt) throw new SettlementOpsError('이미 환불이 실행된 건입니다');
  if (!REFUND_METHODS.includes(input.method)) {
    throw new SettlementOpsError(`환불 방법이 유효하지 않습니다: ${input.method}`);
  }

  // PG 결제 키가 없으면 자동 취소가 불가능하다 — 시도 행을 만들기 전에 막는다
  if (input.method === 'PG_CANCEL' && !s.purchase.paymentKey) {
    throw new SettlementOpsError(
      'PG 결제 키가 없는 구매라 자동 취소할 수 없습니다 — 계좌이체로 환불해주세요 (모의 결제이거나 결제 키를 저장하기 전에 만들어진 건입니다)',
    );
  }
  const bankReference = input.bankReference?.trim() || null;
  if (input.method === 'BANK_TRANSFER' && !bankReference) {
    throw new SettlementOpsError(
      '계좌이체 환불에는 은행 이체 참조번호가 필요합니다 — 이체를 먼저 실행하고 그 번호를 입력해주세요 (같은 번호는 두 번 기록되지 않습니다)',
    );
  }

  // **끝나지 않은 시도가 있으면 새로 만들지 않는다.**
  //
  // PENDING은 "취소가 나갔는지 우리가 모른다"는 뜻이다(응답을 못 받았다). 여기서 새 시도를
  // 만들면 **새 멱등키로 한 번 더 나가** 두 번 빠질 수 있다. 그 시도를 그대로 이어받아
  // 같은 키로 다시 부르는 것이 유일하게 안전한 길이다 — retryRefundAttempt.
  const stuck = await prisma.refundAttempt.findFirst({
    where: { settlementId: s.id, status: 'PENDING' },
  });
  if (stuck) {
    throw new SettlementOpsError(
      `아직 끝나지 않은 환불 시도가 있습니다 (${stuck.amountKrw.toLocaleString()}원, ${stuck.method}). 새로 실행하면 두 번 빠질 수 있어 막았습니다 — 그 시도를 재시도해주세요.`,
    );
  }

  // **시도를 먼저 남기고, 그 id를 멱등키로 쓴다.**
  //
  // 멱등키를 정산 id로 잡으면 "같은 정산의 두 번째 취소"가 영원히 불가능해진다 —
  // 토스가 첫 성공 응답을 그대로 돌려주므로 코드는 성공으로 알고 **돈은 안 나간다.**
  // 판정 정정으로 추가 환불이 필요한 날 조용히 틀린다. 시도마다 키가 새로 생기면
  // 그 위험이 사라지고, 같은 시도의 재시도는 여전히 한 번만 나간다.
  let attempt;
  try {
    attempt = await prisma.refundAttempt.create({
      data: {
        settlementId: s.id,
        amountKrw: s.buyerRefundKrw,
        method: input.method,
        operatorId: input.operatorUserId,
        status: 'PENDING',
        bankReference,
      },
    });
  } catch {
    // @@unique([settlementId, bankReference]) — 같은 이체를 두 번 기록하려 했다
    throw new SettlementOpsError(
      `이 이체 번호(${bankReference})는 이미 이 정산에 기록돼 있습니다. 실제로 두 번 보내셨다면 참조번호가 다를 것입니다 — 은행 앱에서 확인해주세요.`,
    );
  }
  await runRefundAttempt(prisma, s, attempt, now);
}

/**
 * 끝나지 않은 환불 시도를 **같은 멱등키로** 이어받는다.
 *
 * 토스에 멱등키를 실어 보내는 이유가 곧 이것이다 — 상태를 따로 조회하지 않아도 된다.
 * 취소가 이미 나갔다면 토스는 새 취소를 일으키지 않고 **그때의 성공 응답을 그대로**
 * 돌려주고, 아직 안 나갔다면 그제서야 1회 실행한다. 어느 쪽이든 결과는 한 번이다.
 */
export async function retryRefundAttempt(
  prisma: PrismaClient,
  input: { attemptId: string; operatorUserId: string },
  now = new Date(),
) {
  const attempt = await prisma.refundAttempt.findUnique({ where: { id: input.attemptId } });
  if (!attempt) throw new SettlementOpsError('환불 시도를 찾을 수 없습니다');
  if (attempt.status !== 'PENDING') {
    throw new SettlementOpsError(`이미 끝난 시도입니다 (${attempt.status})`);
  }
  if (attempt.method === 'BANK_TRANSFER') {
    // **계좌이체에는 재시도가 없다.** 멱등키가 없으므로 "다시 보낸다"가 곧 이중 송금이다.
    // 사람이 은행 앱에서 실제로 보냈는지 확인해 상태를 확정하는 것만 가능하다
    throw new SettlementOpsError(
      '계좌이체는 자동 재시도할 수 없습니다 — 은행 앱에서 이체 여부를 확인한 뒤 상태를 확정해주세요.',
    );
  }
  const s = await prisma.settlement.findUnique({
    where: { id: attempt.settlementId },
    include: PENDING_INCLUDE,
  });
  if (!s) throw new SettlementOpsError('정산 건을 찾을 수 없습니다');
  if (s.refundExecutedAt) {
    // 기록은 됐는데 시도만 PENDING으로 남은 경우 — 돈은 이미 나갔다. 시도만 닫는다
    await prisma.refundAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', finishedAt: now },
    });
    return;
  }
  await runRefundAttempt(prisma, s, attempt, now, input.operatorUserId);
}

/**
 * 끝나지 않은 **계좌이체** 시도의 상태를 사람이 확정한다 — 재시도가 아니라 확인이다.
 *
 * PG 취소는 멱등키가 있어 "같은 키로 다시 보낸다"가 안전하지만, 은행 앱에서 사람이
 * 보내는 돈에는 그런 장치가 없다. 재시도 버튼을 주면 운영자가 "안 나갔구나" 하고 한 번
 * 더 보낼 수 있고 그건 그대로 이중 송금이다. 그래서 물어보는 것은 하나다 —
 * **실제로 보내셨습니까.**
 *
 * - `SENT`: 이미 보냈다 → 이체 참조번호를 받아 그 시도를 성공으로 닫고 정산을 기록한다
 * - `NOT_SENT`: 안 보냈다 → 시도를 FAILED로 닫아 새 시도를 만들 수 있게 푼다
 */
export async function resolveBankTransferAttempt(
  prisma: PrismaClient,
  input: {
    attemptId: string;
    operatorUserId: string;
    resolution: 'SENT' | 'NOT_SENT';
    bankReference?: string;
  },
  now = new Date(),
) {
  const attempt = await prisma.refundAttempt.findUnique({ where: { id: input.attemptId } });
  if (!attempt) throw new SettlementOpsError('환불 시도를 찾을 수 없습니다');
  if (attempt.method !== 'BANK_TRANSFER') {
    throw new SettlementOpsError('계좌이체 시도가 아닙니다 — PG 취소는 재시도로 처리합니다');
  }
  if (attempt.status !== 'PENDING') {
    throw new SettlementOpsError(`이미 끝난 시도입니다 (${attempt.status})`);
  }

  if (input.resolution === 'NOT_SENT') {
    await prisma.refundAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', error: '운영자 확인: 이체하지 않음', finishedAt: now },
    });
    return;
  }

  const bankReference = input.bankReference?.trim();
  if (!bankReference) {
    throw new SettlementOpsError('이체를 완료했다면 은행 이체 참조번호를 입력해주세요');
  }
  const s = await prisma.settlement.findUnique({
    where: { id: attempt.settlementId },
    include: PENDING_INCLUDE,
  });
  if (!s) throw new SettlementOpsError('정산 건을 찾을 수 없습니다');
  if (s.refundExecutedAt) {
    // 기록은 됐는데 시도만 PENDING으로 남은 경우 — 시도만 닫는다
    await prisma.refundAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', bankReference, finishedAt: now },
    });
    return;
  }
  await prisma.refundAttempt.update({ where: { id: attempt.id }, data: { bankReference } });
  await runRefundAttempt(prisma, s, attempt, now, input.operatorUserId);
}

/** runRefundAttempt가 쓰는 것만 — 조회 형태가 바뀌어도 여기가 흔들리지 않게 좁게 잡는다 */
interface RefundTarget {
  id: string;
  outcome: string;
  purchase: { buyerId: string; paymentKey: string | null; report: { id: string } };
}
type Attempt = { id: string; method: string; amountKrw: number; operatorId: string };

/**
 * 시도 1회를 실제로 실행한다 — 새 시도든 재시도든 여기를 지난다.
 *
 * **돈을 먼저 보내고 기록은 그 다음이다.** 순서를 뒤집으면(기록 먼저 → 취소 호출) 취소가
 * 실패했을 때 "환불 완료" 알림까지 나간 채로 돈은 그대로 있는 상태가 남는다. 구매자는
 * 완료됐다고 믿고, 그 건은 미실행 목록에서도 사라져 아무도 다시 보지 않는다.
 */
async function runRefundAttempt(
  prisma: PrismaClient,
  s: RefundTarget,
  attempt: Attempt,
  now: Date,
  operatorUserId = attempt.operatorId,
) {
  if (attempt.method === 'PG_CANCEL') {
    try {
      await cancelTossPayment({
        paymentKey: s.purchase.paymentKey!,
        cancelReason: refundReason(s.outcome, attempt.amountKrw),
        // 전액이어도 명시한다 — 지시서 금액과 실제로 나간 금액을 같은 값 하나로 묶는다
        cancelAmount: attempt.amountKrw,
        idempotencyKey: `refund_attempt_${attempt.id}`,
      });
    } catch (e) {
      // **"PG가 거절했다"와 "응답을 못 받았다"는 다르다.**
      //
      // TossPaymentError는 토스가 HTTP 응답으로 거절한 경우다 — 돈이 안 나갔다는 것을
      // 우리가 **안다.** 그러면 이 시도는 끝난 것이고(FAILED), 다음 시도는 새 키로 나가야
      // 한다. 반대로 네트워크가 끊겨 응답 자체를 못 받았으면 나갔는지 알 수 없으므로
      // **PENDING으로 남긴다** — 같은 키로 이어받아야 두 번 빠지지 않는다.
      const known = e instanceof TossPaymentError;
      const detail = e instanceof Error ? e.message : String(e);
      if (known) {
        await prisma.refundAttempt.update({
          where: { id: attempt.id },
          data: { status: 'FAILED', error: detail.slice(0, 500), finishedAt: now },
        });
        throw new SettlementOpsError(
          `PG 취소에 실패해 환불을 기록하지 않았습니다 (${detail}). 다시 시도하거나, 취소 기한이 지난 건이면 계좌이체로 환불해주세요.`,
        );
      }
      await prisma.refundAttempt.update({
        where: { id: attempt.id },
        data: { error: detail.slice(0, 500) }, // PENDING 유지
      });
      throw new SettlementOpsError(
        `PG 응답을 받지 못해 취소가 나갔는지 확인할 수 없습니다 (${detail}). 이 시도를 **재시도**해주세요 — 같은 키로 나가므로 두 번 빠지지 않습니다.`,
      );
    }
  }

  await prisma.$transaction([
    prisma.refundAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', finishedAt: now },
    }),
    prisma.refundAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', finishedAt: now },
    }),
    prisma.settlement.update({
      // 동시 실행 대비: 미실행 조건을 다시 걸어 원자적으로 기록
      where: { id: s.id, refundExecutedAt: null },
      data: {
        refundMethod: attempt.method,
        refundExecutedAt: now,
        refundExecutedBy: operatorUserId,
      },
    }),
    prisma.notification.create({
      data: {
        userId: s.purchase.buyerId,
        type: 'REFUND_EXECUTED',
        title: `환불 완료: ${attempt.amountKrw.toLocaleString()}원`,
        body:
          attempt.method === 'PG_CANCEL'
            ? '결제 취소가 접수되었습니다. 카드사 사정에 따라 3~5영업일 내 환불됩니다.'
            : '계좌이체 환불이 실행되었습니다.',
        link: `/report/${s.purchase.report.id}`,
        createdAt: now,
      },
    }),
  ]);
}

/**
 * 끝나지 않은 시도를 몇 분 지나면 방치로 보는가.
 *
 * PG 취소는 초 단위로 끝나는 호출이라 30분이 남아 있으면 정상 경로가 아니다.
 * 결제 쪽 `REQUIRES_MANUAL_VOID`(고객이 돈을 냈는데 못 받은 상태)와 달리 이쪽은
 * 며칠 안에만 환불되면 되는 건이라 즉시 알림이 아니라 배치로 묶어 올린다.
 */
export const STUCK_REFUND_MINUTES = 30;

/**
 * 방치된 환불 시도를 찾아 운영자에게 **묶어서** 알린다 (스케줄러가 주기적으로 부른다).
 *
 * PENDING은 "취소가 나갔는지 우리가 모른다"는 뜻인데, 지금까지 그 행을 **아무도 다시
 * 보지 않았다.** 정산 큐에는 보이지만 큐를 안 열면 그만이다. 건마다 알리면 소음이 되므로
 * 한 번에 하나로 묶고, 이미 알린 건은 다시 세지 않는다(escalatedAt).
 */
export async function sweepStuckRefundAttempts(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ stuck: number; notified: boolean; reconciled: number }> {
  const cutoff = new Date(now.getTime() - STUCK_REFUND_MINUTES * 60_000);
  const candidates = await prisma.refundAttempt.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff }, escalatedAt: null },
    include: { settlement: { select: { refundExecutedAt: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // **먼저 스스로 맞춘다.** 정산이 이미 실행된 건의 PENDING 시도는 "돈은 나갔는데
  // 시도 행만 안 닫힌" 상태다 — 알릴 일이 아니라 닫을 일이다.
  //
  // 이걸 알림으로 올리면 더 나쁘다: 알림은 /admin/settlements를 가리키는데 그 화면은
  // **미실행 환불만** 보여준다(refundExecutedAt: null). 운영자는 알림을 받고 들어가
  // 아무것도 없는 목록을 보게 되고, 그 다음부터 이 알림을 믿지 않는다.
  const settled = candidates.filter((a) => a.settlement.refundExecutedAt !== null);
  if (settled.length > 0) {
    await prisma.refundAttempt.updateMany({
      where: { id: { in: settled.map((a) => a.id) } },
      data: { status: 'SUCCEEDED', finishedAt: now },
    });
  }

  const stuck = candidates.filter((a) => a.settlement.refundExecutedAt === null);
  if (stuck.length === 0) return { stuck: 0, notified: false, reconciled: settled.length };

  const total = stuck.reduce((a, r) => a + r.amountKrw, 0);
  await notifyOperators(prisma, {
    title: `[확인 필요] 끝나지 않은 환불 시도 ${stuck.length}건 · ${total.toLocaleString()}원`,
    body: [
      `${STUCK_REFUND_MINUTES}분 넘게 PENDING으로 남아 있습니다 — 돈이 나갔는지 확인되지 않은 상태입니다.`,
      // **수단마다 할 일이 다르다.** PG는 멱등키가 있어 재시도가 안전하지만,
      // 계좌이체는 재시도가 곧 이중 송금이라 은행 앱 확인이 먼저다
      `· PG 취소: 정산 콘솔에서 **재시도** (같은 키로 나가므로 두 번 빠지지 않습니다)`,
      `· 계좌이체: **은행 앱에서 이체 여부를 먼저 확인**한 뒤 상태를 확정해주세요`,
      ...stuck
        .slice(0, 10)
        .map((r) => `· ${r.method} ${r.amountKrw.toLocaleString()}원 · 시도 ${r.id}`),
      ...(stuck.length > 10 ? [`… 외 ${stuck.length - 10}건`] : []),
    ].join('\n'),
    link: '/admin/settlements',
  });

  // 같은 건을 매 회차 다시 알리지 않는다 — 소음이 되면 아무도 안 읽는다
  await prisma.refundAttempt.updateMany({
    where: { id: { in: stuck.map((r) => r.id) } },
    data: { escalatedAt: now },
  });
  return { stuck: stuck.length, notified: true, reconciled: settled.length };
}

/** 리서처 지급 실행 기록 + 리서처 알림. 이미 실행된 건은 거부 */
export async function executePayout(
  prisma: PrismaClient,
  input: { settlementId: string; operatorUserId: string },
  now = new Date(),
) {
  const s = await prisma.settlement.findUnique({
    where: { id: input.settlementId },
    include: PENDING_INCLUDE,
  });
  if (!s) throw new SettlementOpsError('정산 건을 찾을 수 없습니다');
  if (s.researcherPayoutKrw <= 0) throw new SettlementOpsError('지급액이 없는 정산 건입니다');
  if (s.payoutExecutedAt) throw new SettlementOpsError('이미 지급이 실행된 건입니다');

  await prisma.$transaction([
    prisma.settlement.update({
      where: { id: s.id, payoutExecutedAt: null },
      data: { payoutExecutedAt: now, payoutExecutedBy: input.operatorUserId },
    }),
    prisma.notification.create({
      data: {
        userId: s.purchase.report.researcher.userId,
        type: 'PAYOUT_EXECUTED',
        title: `정산 지급 완료: ${s.researcherPayoutKrw.toLocaleString()}원`,
        body: `"${s.purchase.report.title}" 판매 정산금이 지급되었습니다.`,
        link: `/researcher/${s.purchase.report.researcherId}`,
        createdAt: now,
      },
    }),
  ]);
}
