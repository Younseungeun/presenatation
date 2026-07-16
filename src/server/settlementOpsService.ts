import type { PrismaClient } from '@prisma/client';

// 정산 실행 콘솔 (운영자): 판정이 만든 환불·지급 지시서를 사람이 실행하고 기록한다.
// PG 취소·계좌이체·지급이체가 자동화되기 전의 수동 운영 경로 —
// 자동화가 붙어도 "지시서 → 실행 기록" 구조는 그대로 유지된다 (실행 주체만 교체).

export const REFUND_METHODS = ['PG_CANCEL', 'BANK_TRANSFER'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

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

/** 환불 실행 기록 + 구매자 알림. 이미 실행된 건은 거부 (이중 지급 방지) */
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

  await prisma.$transaction([
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
