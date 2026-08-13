import type { PrismaClient } from '@prisma/client';
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

/** 미실행 환불 지시서 — 오래된 순 (PG 취소 기한 관리) */
export function getPendingRefunds(prisma: PrismaClient) {
  return prisma.settlement.findMany({
    where: { buyerRefundKrw: { gt: 0 }, refundExecutedAt: null },
    include: PENDING_INCLUDE,
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
  input: { settlementId: string; operatorUserId: string; method: RefundMethod },
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
  const paymentKey = s.purchase.paymentKey;
  if (input.method === 'PG_CANCEL' && !paymentKey) {
    throw new SettlementOpsError(
      'PG 결제 키가 없는 구매라 자동 취소할 수 없습니다 — 계좌이체로 환불해주세요 (모의 결제이거나 결제 키를 저장하기 전에 만들어진 건입니다)',
    );
  }

  // **시도를 먼저 남기고, 그 id를 멱등키로 쓴다.**
  //
  // 멱등키를 정산 id로 잡으면 "같은 정산의 두 번째 취소"가 영원히 불가능해진다 —
  // 토스가 첫 성공 응답을 그대로 돌려주므로 코드는 성공으로 알고 **돈은 안 나간다.**
  // 판정 정정으로 추가 환불이 필요한 날 조용히 틀린다. 시도마다 키가 새로 생기면
  // 그 위험이 사라지고, 같은 시도의 재시도는 여전히 한 번만 나간다.
  const attempt = await prisma.refundAttempt.create({
    data: {
      settlementId: s.id,
      amountKrw: s.buyerRefundKrw,
      method: input.method,
      operatorId: input.operatorUserId,
      status: 'PENDING',
    },
  });

  // **돈을 먼저 보내고 기록은 그 다음이다.**
  //
  // 순서를 뒤집으면(기록 먼저 → 취소 호출) 취소가 실패했을 때 "환불 완료" 알림까지
  // 나간 채로 돈은 그대로 있는 상태가 남는다. 구매자는 완료됐다고 믿고, 그 건은
  // 미실행 목록에서도 사라져 아무도 다시 보지 않는다 — 조용히 틀리는 방향이다.
  //
  // 이 순서의 위험은 반대다: 취소는 됐는데 기록이 실패하면 미실행으로 남아 운영자가
  // 다시 누른다. 그때는 **이 시도 행이 PENDING으로 남아 있다** — 재시도 화면이 같은
  // 시도를 이어받으면 같은 키로 나가 두 번 빠지지 않는다.
  if (input.method === 'PG_CANCEL') {
    try {
      await cancelTossPayment({
        paymentKey: paymentKey!,
        cancelReason: refundReason(s.outcome, s.buyerRefundKrw),
        // 전액이어도 명시한다 — 지시서 금액과 실제로 나간 금액을 같은 값 하나로 묶는다
        cancelAmount: s.buyerRefundKrw,
        idempotencyKey: `refund_attempt_${attempt.id}`,
      });
    } catch (e) {
      const detail = e instanceof TossPaymentError ? e.message : String(e);
      await prisma.refundAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', error: detail.slice(0, 500), finishedAt: now },
      });
      throw new SettlementOpsError(
        `PG 취소에 실패해 환불을 기록하지 않았습니다 (${detail}). 다시 시도하거나, 취소 기한이 지난 건이면 계좌이체로 환불해주세요.`,
      );
    }
  }

  await prisma.$transaction([
    prisma.refundAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', finishedAt: now },
    }),
    prisma.settlement.update({
      // 동시 실행 대비: 미실행 조건을 다시 걸어 원자적으로 기록
      where: { id: s.id, refundExecutedAt: null },
      data: {
        refundMethod: input.method,
        refundExecutedAt: now,
        refundExecutedBy: input.operatorUserId,
      },
    }),
    prisma.notification.create({
      data: {
        userId: s.purchase.buyerId,
        type: 'REFUND_EXECUTED',
        title: `환불 완료: ${s.buyerRefundKrw.toLocaleString()}원`,
        body:
          input.method === 'PG_CANCEL'
            ? '결제 취소가 접수되었습니다. 카드사 사정에 따라 3~5영업일 내 환불됩니다.'
            : '계좌이체 환불이 실행되었습니다.',
        link: `/report/${s.purchase.report.id}`,
        createdAt: now,
      },
    }),
  ]);
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
