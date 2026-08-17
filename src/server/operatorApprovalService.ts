import { createHash, randomBytes } from 'node:crypto';
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
  // 만료는 조용히 일어나면 안 된다 (검토 5차 Q3) — 기안자는 실행하러 갔다가
  // "승인이 필요합니다"를 다시 만나서야 알게 된다. 상태 전이는 한 번뿐이므로
  // (EXPIRED가 되면 다시는 이 where에 안 걸린다) 알림도 정확히 한 번 나간다
  const stale = await prisma.operatorApproval.findMany({
    where: {
      OR: [
        { status: 'PENDING', requestedAt: { lt: cutoff } },
        { status: 'APPROVED', decidedAt: { lt: cutoff } },
      ],
    },
    select: { id: true, requestedBy: true, action: true, summary: true, status: true },
  });
  if (stale.length === 0) return;
  await prisma.$transaction([
    prisma.operatorApproval.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: 'EXPIRED' },
    }),
    prisma.notification.createMany({
      data: stale.map((s) => ({
        userId: s.requestedBy,
        type: 'OPS_ALERT',
        title: `[만료] ${APPROVAL_ACTION_LABEL[s.action as ApprovalAction] ?? s.action}`,
        body:
          s.status === 'PENDING'
            ? `요청이 ${APPROVAL_TTL_HOURS}시간 동안 승인되지 않아 자동 만료되었습니다.\n` +
              `${s.summary}\n필요하면 사유를 다시 써서 새로 요청하세요.`
            : `승인서가 ${APPROVAL_TTL_HOURS}시간 안에 실행되지 않아 만료되었습니다.\n` +
              `${s.summary}\n아직 필요한 일이면 처음부터 다시 요청하세요 — 사흘이 지난 판단은 다시 내려야 합니다.`,
        link: '/admin/approvals',
        createdAt: now,
      })),
    }),
  ]);
}

/**
 * 만료 임박 재알림 (검토 5차 Q3, @근거 설계 만료 전 마지막 하루의 문턱 — 매일 울리면 배경음이 된다).
 * 요청 후 48시간이 지난 대기 건을 운영자들에게 **한 번만** 다시 알린다.
 * 스케줄러가 하루 한 번 부른다.
 */
export const APPROVAL_REMINDER_AFTER_HOURS = 48;

export async function notifyApprovalReminders(
  prisma: PrismaClient,
  now = new Date(),
): Promise<number> {
  await expireStaleApprovals(prisma, now);
  const cutoff = new Date(now.getTime() - APPROVAL_REMINDER_AFTER_HOURS * 3_600_000);
  const due = await prisma.operatorApproval.findMany({
    where: { status: 'PENDING', requestedAt: { lt: cutoff }, remindedAt: null },
    select: { id: true, action: true, summary: true },
  });
  if (due.length === 0) return 0;
  await prisma.operatorApproval.updateMany({
    where: { id: { in: due.map((d) => d.id) } },
    data: { remindedAt: now },
  });
  await notifyOperators(prisma, {
    title: `[만료 임박] 승인 대기 ${due.length}건 — 24시간 뒤 자동 만료`,
    body: [
      ...due.map((d) => `· ${APPROVAL_ACTION_LABEL[d.action as ApprovalAction] ?? d.action} — ${d.summary}`),
      '만료되면 기안자가 사유부터 다시 써야 합니다.',
    ].join('\n'),
    link: '/admin/approvals',
  });
  return due.length;
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

// ── 1인 운영 모드 (2026-08-17 사용자 확정) ────────────────────
//
// 사업 초기에는 운영자가 창업자 1명뿐이고, 그때 2인 승인은 **아무도 안 지키면서
// 본인만 막는 절차**다 — 내부자 후보가 코드·DB·배포를 전부 쥔 창업자 본인이라,
// 앱 관문이 막을 수 있는 상대가 아니다. 그렇다고 관문을 없애면 **계정 탈취**
// (세션·기기를 훔친 외부자)까지 열린다. 그래서 두 번째 사람 자리를
// **실행 직전 생체 재확인**으로 갈아끼운다:
//   세션만 훔친 사람 → 생체가 없어 못 한다
//   폰을 주운 사람   → 얼굴·지문이 필요해 못 한다
//   창업자 본인      → 1초
// 진짜 운영자가 2명이 되는 순간 자동으로 2인 승인으로 돌아간다.

/** 진짜(콜드 제외) 운영자가 1명 이하인가 — 이 판정이 두 체제를 가른다 */
export async function isSoloOperatorMode(prisma: PrismaClient): Promise<boolean> {
  const real = await prisma.user.count({ where: { role: 'OPERATOR', operatorCold: false } });
  return real <= 1;
}

/**
 * 생체 재확인의 유효 시간 — 재확인하고 실행 버튼을 누르기까지의 여유다.
 * 길게 두면 그만큼 "재확인해 둔 세션"을 훔칠 창이 된다.
 * @근거 설계 재확인 직후 실행을 마치기에 넉넉하되, 훔친 세션이 얹혀 갈 창은 좁게
 */
export const OPERATOR_RECHECK_WINDOW_MS = 5 * 60_000;

const hashRecheckToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * 생체를 통과한 화면에 **1회용 표**를 발급한다 (2026-08-17 자체 발견 결함 수정).
 *
 * 표를 쓰는 이유: 재확인을 사용자 단위로만 찍으면 **훔친 세션이 창업자의 재확인에
 * 얹혀 간다.** 공격자가 다른 기기에서 세션을 쥐고 기다리다가, 창업자가 지문을 대는
 * 순간 같이 통과하는 것이다 — 이 장치가 막겠다고 한 바로 그 상대에게 뚫린다.
 * 표는 생체를 통과한 응답으로만 나가므로, 세션만 있는 쪽은 손에 넣을 수 없다.
 */
export async function issueOperatorRecheck(
  prisma: PrismaClient,
  operatorUserId: string,
  now = new Date(),
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await prisma.user.update({
    where: { id: operatorUserId },
    data: { operatorRecheckAt: now, operatorRecheckTokenHash: hashRecheckToken(token) },
  });
  return token;
}

/**
 * 재확인 표를 **써서 없앤다** — 승인서와 같은 1회용이다.
 * 표 하나로 두 가지 실행이 나가면, 두 번째는 확인받지 않은 실행이다.
 */
export async function consumeOperatorRecheck(
  prisma: PrismaClient,
  operatorUserId: string,
  token: string | undefined,
  now = new Date(),
): Promise<void> {
  const fail = () =>
    new ApprovalError('실행 직전 지문·얼굴 확인이 필요합니다 — 확인 후 다시 실행하세요.');
  if (!token) throw fail();
  const cutoff = new Date(now.getTime() - OPERATOR_RECHECK_WINDOW_MS);
  // 표와 시간을 **한 조건에** 걸고 건수로 판정한다 — 조회 후 삭제로 나누면 같은 표로
  // 두 요청이 동시에 통과한다(승인서 소비와 같은 이유)
  const { count } = await prisma.user.updateMany({
    where: {
      id: operatorUserId,
      operatorRecheckAt: { gte: cutoff },
      operatorRecheckTokenHash: hashRecheckToken(token),
    },
    data: { operatorRecheckAt: null, operatorRecheckTokenHash: null },
  });
  if (count === 0) throw fail();
}

/** 대기 중인 요청 (운영자 화면) */
export async function getPendingApprovals(prisma: PrismaClient, now = new Date()) {
  await expireStaleApprovals(prisma, now); // 화면에 뜨는 것은 전부 아직 살아 있는 요청이다
  return prisma.operatorApproval.findMany({
    where: { status: 'PENDING' },
    orderBy: { requestedAt: 'asc' },
  });
}
