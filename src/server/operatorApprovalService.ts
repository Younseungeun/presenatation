import type { PrismaClient } from '@prisma/client';
import {
  APPROVAL_ACTION_LABEL,
  APPROVAL_TTL_HOURS,
  canApprove,
  type ApprovalAction,
  type ApprovalStatus,
} from '@/domain/operatorApproval';
import { notifyOperators } from './opsAlert';

// 운영자 2인 승인 실행부 — 요청·승인·소비.
//
// ── 흐름 ──────────────────────────────────────────────────────
//   requestApproval   운영자 A가 "이걸 하겠다"고 올린다 → 다른 운영자에게 알림
//   decideApproval    운영자 B가 승인/반려 (A는 못 한다 — domain/operatorApproval)
//   consumeApproval   실행 직전에 승인서를 **써서 없앤다**
//
// ── 승인서는 1회용이다 ────────────────────────────────────────
// `consumeApproval`이 상태를 EXECUTED로 바꾸며 건수로 판정한다. 조회 후 실행으로
// 나누면 같은 승인서로 두 번 실행할 수 있고, 그건 곧 **승인 한 번에 돈이 두 번**
// 나가는 것이다.

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/**
 * 낡은 요청·승인서를 만료시킨다 (2026-08-16 검토 4차 Q3 — 지연 평가).
 *
 * 스케줄러 배치가 아니라 **모든 진입로 첫머리**에서 부른다. 배치 방식은 배치가 죽은
 * 사이 낡은 승인서가 산 것처럼 보이는 창이 생기는데, 지연 평가는 그 창 자체가 없다 —
 * 읽는 순간이 곧 판정 순간이다. 대기는 요청 시각부터, 승인서는 승인 시각부터 센다
 * (승인만 받아 두고 반년 뒤에 소비되는 승인서는 낡은 대기보다 더 나쁘다).
 */
async function expireStaleApprovals(prisma: PrismaClient, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - APPROVAL_TTL_HOURS * 3_600_000);
  await prisma.operatorApproval.updateMany({
    where: {
      OR: [
        { status: 'PENDING', requestedAt: { lt: cutoff } },
        { status: 'APPROVED', decidedAt: { lt: cutoff } },
      ],
    },
    data: { status: 'EXPIRED' },
  });
}

export async function requestApproval(
  prisma: PrismaClient,
  input: {
    action: ApprovalAction;
    targetId: string;
    summary: string;
    amountKrw?: number | null;
    requestedBy: string;
    reason: string;
  },
  now = new Date(),
): Promise<{ id: string }> {
  if (!input.reason.trim()) {
    throw new ApprovalError('무엇을 왜 하려는지 적어주세요 — 승인자가 판단할 근거가 됩니다');
  }
  await expireStaleApprovals(prisma, now); // 만료된 대기 건을 산 것으로 착각하고 재사용하지 않게
  // 같은 대상에 대기 중인 요청이 있으면 새로 만들지 않는다. 안 그러면 승인자가
  // 같은 건을 여러 번 승인하게 되고, 그중 하나만 소비돼 나머지가 유령으로 남는다
  const existing = await prisma.operatorApproval.findFirst({
    where: { action: input.action, targetId: input.targetId, status: 'PENDING' },
  });
  if (existing) return { id: existing.id };

  const created = await prisma.operatorApproval.create({
    data: {
      action: input.action,
      targetId: input.targetId,
      summary: input.summary,
      amountKrw: input.amountKrw ?? null,
      requestedBy: input.requestedBy,
      reason: input.reason.trim(),
      requestedAt: now,
    },
  });

  await notifyOperators(prisma, {
    title: `[승인 요청] ${APPROVAL_ACTION_LABEL[input.action]}`,
    body: [
      input.summary,
      `사유: ${input.reason.trim()}`,
      '**요청한 사람은 승인할 수 없습니다** — 다른 운영자가 확인해주세요.',
    ].join('\n'),
    link: '/admin/approvals',
  });
  return { id: created.id };
}

export async function decideApproval(
  prisma: PrismaClient,
  input: {
    approvalId: string;
    approverUserId: string;
    approve: boolean;
    note?: string;
  },
  now = new Date(),
): Promise<ApprovalStatus> {
  await expireStaleApprovals(prisma, now);
  const row = await prisma.operatorApproval.findUnique({ where: { id: input.approvalId } });
  if (!row) throw new ApprovalError('요청을 찾을 수 없습니다');

  const verdict = canApprove({
    requestedBy: row.requestedBy,
    approverUserId: input.approverUserId,
    status: row.status as ApprovalStatus,
  });
  if (!verdict.ok) throw new ApprovalError(verdict.reason);

  const status: ApprovalStatus = input.approve ? 'APPROVED' : 'REJECTED';
  await prisma.operatorApproval.update({
    where: { id: input.approvalId },
    data: { status, decidedBy: input.approverUserId, decidedAt: now, decisionNote: input.note ?? null },
  });
  return status;
}

/**
 * 실행 직전에 승인서를 **쓰면서 없앤다** — 없으면 던진다.
 *
 * `updateMany`의 건수로 판정하는 이유: 조회 후 실행으로 나누면 두 요청이 같은
 * 승인서를 동시에 통과한다. 상태를 바꾸는 데 성공한 쪽만 그 승인서의 주인이다.
 */
export async function consumeApproval(
  prisma: PrismaClient,
  input: { action: ApprovalAction; targetId: string },
  now = new Date(),
): Promise<void> {
  await expireStaleApprovals(prisma, now); // 낡은 승인서는 소비되기 전에 여기서 죽는다
  const { count } = await prisma.operatorApproval.updateMany({
    where: { action: input.action, targetId: input.targetId, status: 'APPROVED' },
    data: { status: 'EXECUTED', executedAt: now },
  });
  if (count === 0) {
    throw new ApprovalError(
      `${APPROVAL_ACTION_LABEL[input.action]}에는 다른 운영자의 승인이 필요합니다 — 승인 요청을 먼저 올려주세요.`,
    );
  }
}

/** 대기 중인 요청 (운영자 화면) */
export async function getPendingApprovals(prisma: PrismaClient, now = new Date()) {
  await expireStaleApprovals(prisma, now); // 화면에 뜨는 것은 전부 아직 살아 있는 요청이다
  return prisma.operatorApproval.findMany({
    where: { status: 'PENDING' },
    orderBy: { requestedAt: 'asc' },
  });
}
