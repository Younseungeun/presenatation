import type { PrismaClient } from '@prisma/client';
import { auditOp } from './auditLog';

// 운영자 권한 부여·회수 (2026-08-16 검토 4차 Q2 — 콜드 계정 회수를 코드로 강제).
//
// ── 콜드 계정이 무엇인가 ──────────────────────────────────────
// 출시 초 운영자가 1명일 때 2인 승인의 교착을 푸는 **금고 속 두 번째 계정**이다.
// 실제로는 "2인"이 아니라 **한 사람 + 두 번째 기기**다 — 막는 것은 계정 하나의
// 탈취(공격자는 금고까지 뚫어야 한다)이고, 못 막는 것은 그 한 사람의 악의다.
// 출시 초에는 운영자 = 창업자 = 돈의 주인이라 내부자 위협이 공집합이므로 수용한다.
//
// ── 회수는 수칙이 아니라 코드가 한다 ─────────────────────────
// 진짜 두 번째 운영자가 생기는 순간 콜드를 남겨 두면 "운영자 2명 + 콜드 1개"가 되어
// **한 사람이 콜드를 쥐고 다시 단독 승인 능력**을 갖는다. 운영 수칙은 잊히고,
// 잊힌 백도어는 가장 오래 사는 취약점이다. 그래서 두 번째 진짜 운영자를 부여하는
// 트랜잭션이 **콜드 강등을 원자적으로 함께** 실행한다 — 두 상태가 공존하는 순간이 없다.

export class OperatorGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorGrantError';
  }
}

export interface GrantResult {
  userId: string;
  role: string;
  /** 이번 부여가 강등시킨 콜드 계정 이메일들 */
  demotedColdAccounts: string[];
}

export async function grantOperatorRole(
  prisma: PrismaClient,
  input: { email: string; cold?: boolean; actor: string },
  now = new Date(),
): Promise<GrantResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) throw new OperatorGrantError(`계정을 찾을 수 없습니다: ${input.email}`);

  if (input.cold) {
    // 콜드는 **1인 체제의 임시 장치**다. 진짜 운영자가 이미 2명이면 2인 승인이 서
    // 있는데, 거기에 콜드를 더하는 것은 단독 승인 백도어를 새로 파는 것이다
    const realOperators = await prisma.user.count({
      where: { role: 'OPERATOR', operatorCold: false, id: { not: user.id } },
    });
    if (realOperators >= 2) {
      throw new OperatorGrantError(
        '운영자가 이미 2명 이상입니다 — 콜드 계정은 1인 운영의 교착을 푸는 장치라, ' +
          '지금 만들면 한 사람의 단독 승인 백도어가 됩니다.',
      );
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { role: 'OPERATOR', operatorCold: true },
      }),
      auditOp(prisma, {
        actor: input.actor,
        actorType: 'OPERATOR',
        action: 'ROLE_CHANGED',
        targetType: 'User',
        targetId: user.id,
        before: { role: user.role },
        after: { role: 'OPERATOR', cold: true },
        reason: '콜드 운영자 계정 부여 (1인 운영 교착 해소용)',
        at: now,
      }),
    ]);
    return { userId: user.id, role: 'OPERATOR', demotedColdAccounts: [] };
  }

  // 진짜 운영자 부여 — 부여 후 진짜가 2명 이상이 되면 콜드를 **같은 트랜잭션에서** 강등.
  // 강등은 role만 내리는 것이 아니라 sessionEpoch를 올려 **살아 있는 세션까지 끊는다**
  // (기기 삭제와 같은 규칙 — 지우기만 하면 이미 열린 창이 그대로다).
  // 배열형 $transaction 하나에 부여·강등·감사가 전부 들어간다 — 인터랙티브 트랜잭션은
  // 이 코드베이스가 금지한다(noIoInTransaction). 대상 집계를 트랜잭션 밖에서 읽는 대가로
  // 동시 부여 사이의 경합이 생기지만, 부여는 CLI에서 사람이 한 번 치는 일이다
  const otherReal = await prisma.user.count({
    where: { role: 'OPERATOR', operatorCold: false, id: { not: user.id } },
  });
  const demoted =
    otherReal + 1 >= 2
      ? await prisma.user.findMany({
          where: { role: 'OPERATOR', operatorCold: true, id: { not: user.id } },
          select: { id: true, email: true },
        })
      : [];

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { role: 'OPERATOR', operatorCold: false },
    }),
    ...demoted.map((c) =>
      prisma.user.update({
        where: { id: c.id },
        data: { role: 'USER', operatorCold: false, sessionEpoch: { increment: 1 } },
      }),
    ),
    auditOp(prisma, {
      actor: input.actor,
      actorType: 'OPERATOR',
      action: 'ROLE_CHANGED',
      targetType: 'User',
      targetId: user.id,
      before: { role: user.role },
      after: { role: 'OPERATOR', cold: false },
      reason: demoted.length
        ? `운영자 부여 — 콜드 계정 ${demoted.length}개 동시 강등`
        : '운영자 부여',
      at: now,
    }),
    ...demoted.map((c) =>
      auditOp(prisma, {
        actor: input.actor,
        actorType: 'OPERATOR',
        action: 'ROLE_CHANGED',
        targetType: 'User',
        targetId: c.id,
        before: { role: 'OPERATOR', cold: true },
        after: { role: 'USER' },
        reason: '진짜 운영자 2명 확보 — 콜드 계정은 남겨 두면 단독 승인 백도어가 된다',
        at: now,
      }),
    ),
  ]);

  return {
    userId: user.id,
    role: 'OPERATOR',
    demotedColdAccounts: demoted.map((c) => c.email),
  };
}

export async function revokeOperatorRole(
  prisma: PrismaClient,
  input: { email: string; actor: string },
  now = new Date(),
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) throw new OperatorGrantError(`계정을 찾을 수 없습니다: ${input.email}`);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      // 회수도 세션을 끊는다 — 권한을 내렸는데 열려 있는 운영자 세션이 남으면 회수가 아니다
      data: { role: 'USER', operatorCold: false, sessionEpoch: user.sessionEpoch + 1 },
    }),
    auditOp(prisma, {
      actor: input.actor,
      actorType: 'OPERATOR',
      action: 'ROLE_CHANGED',
      targetType: 'User',
      targetId: user.id,
      before: { role: user.role, cold: user.operatorCold },
      after: { role: 'USER' },
      reason: '운영자 권한 회수',
      at: now,
    }),
  ]);
}
