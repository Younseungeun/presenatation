import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  APPROVAL_ACTION_LABEL,
  APPROVAL_TTL_HOURS,
  canApprove,
  type ApprovalAction,
  type ApprovalStatus,
} from '@/domain/operatorApproval';
import { ELEVATED_RISK_HOLD_MS } from './authGates';
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
 * 재확인 표의 유효 시간 — **5분에서 60초로 줄였다** (2026-08-17 검토 7차 Q3).
 *
 * 5분의 근거는 "얹혀 갈 창"이었다. **그 전제가 사라졌다** — 표가 1회용이 되면서
 * 남이 얹혀 가는 길 자체가 없어졌고, 이제 이 창이 재는 것은 단 하나다:
 * **표를 쥔 화면이 실행을 마치기까지의 시간.** 실제 흐름은 생체 통과 → 즉시 자동
 * 재시도라 1초 내외다.
 *
 * 그러면 남은 위협은 "발급된 표가 브라우저 메모리에 방치되는 시간"이고, 그건 짧을수록
 * 좋다. 60초는 네트워크 지연과 잠깐의 주저함을 덮고도 남는다 — 넘으면 화면이 지문을
 * 한 번 더 받으면 그만이라, 보안도 편의도 잃지 않는다.
 *
 * @근거 설계 표가 1회용이 되어 창이 재는 것은 "실행을 마칠 시간"뿐 — 네트워크 지연을 덮는 최소치
 */
export const OPERATOR_RECHECK_WINDOW_MS = 60_000;

const hashRecheckToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * 비상 복구를 쓴 계정이 돈에 다시 닿을 수 있는 시각 (안 썼으면 null).
 *
 * 길이는 `ELEVATED_RISK_HOLD_MS`를 그대로 쓴다 — 근거가 같기 때문이다:
 * **본인이 알아채고 멈출 수 있는 시간.** 여기서 새 숫자를 만들면 같은 근거의 값이
 * 둘이 되고, 언젠가 한쪽만 바뀐다.
 */
async function recoveryHoldUntil(
  prisma: PrismaClient,
  operatorUserId: string,
): Promise<Date | null> {
  const row = await prisma.user.findUnique({
    where: { id: operatorUserId },
    select: { recoveredAt: true },
  });
  if (!row?.recoveredAt) return null;
  return new Date(row.recoveredAt.getTime() + ELEVATED_RISK_HOLD_MS);
}

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

  // ── 비상 복구 직후 유예 (2026-08-17 검토 7차 Q1 보완 — 자체 발견) ──
  //
  // 여기가 **1인 모드에서 돈이 나가는 모든 길이 지나는 한 지점**이다(동결 해제·지급·
  // 수동 판정·이의 인정). 그래서 이 유예를 여기 하나에만 건다 — 네 곳에 나눠 걸면
  // 언젠가 다섯 번째 길이 생기고 그 길에는 안 걸린다.
  //
  // 막는 상대: **금고의 종이를 훔친 사람.** 그는 복구 화면에서 자기 지문을 등록할 수
  // 있고, 그러면 그 뒤의 생체 재확인은 그의 지문으로 통과한다. 유예가 없으면
  // "종이를 훔치면 돈이 나간다"가 되어 복구 경로가 곧 물리 백도어가 된다.
  const holdUntil = await recoveryHoldUntil(prisma, operatorUserId);
  if (holdUntil && holdUntil > now) {
    const hours = Math.ceil((holdUntil.getTime() - now.getTime()) / 3_600_000);
    throw new ApprovalError(
      `비상 복구를 쓴 직후에는 돈이 나가는 기능이 ${hours}시간 동안 멈춥니다.\n` +
        `본인이 복구한 것이 아니라면 지금 바로 종이 열쇠를 폐기하고 공개키를 교체하세요.\n` +
        `(정산 동결처럼 돈을 **막는** 조작은 지금도 됩니다)`,
    );
  }
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
