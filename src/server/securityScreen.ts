import type { PrismaClient } from '@prisma/client';
import { decryptField } from '@/server/fieldCrypto';
import { listFrozenAccounts } from '@/server/payoutAccountService';

// 보안 화면이 한 번에 읽는 것 (시안 v3 scr-sec).
//
// **네 묶음은 "내가 할 일이 있는가"로 갈린다** — 건수가 아니라 개입의 유무다:
//   동결 목록      본인이 스스로 잠갔다 → **이대로 두는 것이 정상**, 연락이 와야 시작
//   계좌 명의 확인 이름이 안 맞는다 → 확인 전까지 한 푼도 안 나간다, **내가 판단해야 한다**
//   계좌 변경 유예 낯선 기기에서 바꿨다 → 48시간 흐르는 중, **내가 할 일은 없다**
//   보안 신호      낯선 로그인·기기 변경 → **없는 것이 정상**
//
// 셋은 읽는 자리고 하나(명의 확인)만 손대는 자리다. 그 차이가 화면에 있어야
// 열 때마다 "무엇을 해야 하지"를 다시 묻지 않는다.

/** @근거 설계 분기 실적처럼 훑는 창이 아니라 "최근에 이상이 있었나"를 묻는 창이다 */
const SIGNAL_WINDOW_DAYS = 90;

/** 계정을 노리는 일이 남기는 자국 — 종류가 늘면 여기만 고친다 */
const SIGNAL_TYPES = ['RISKY_LOGIN', 'DEVICE_ADDED', 'DEVICE_REMOVED', 'PASSKEY_REMOVED', 'PIN_LOCKED'];

export async function getSecurityScreen(prisma: PrismaClient, now = new Date()) {
  const since = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 86_400_000);

  const [frozen, mismatches, cooldowns, signals] = await Promise.all([
    listFrozenAccounts(prisma),
    prisma.payoutAccount.findMany({
      where: { status: 'HOLDER_MISMATCH' },
      select: {
        researcherUserId: true,
        bankCode: true,
        accountLast4: true,
        holderName: true,
        verifiedNameEnc: true,
      },
    }),
    prisma.payoutAccount.findMany({
      where: { cooldownUntil: { gt: now } },
      select: {
        researcherUserId: true,
        accountLast4: true,
        cooldownUntil: true,
        createdAt: true,
      },
      orderBy: { cooldownUntil: 'asc' },
    }),
    prisma.notification.findMany({
      where: { type: { in: SIGNAL_TYPES }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  // 이름은 **여기서만** 푼다 — 대조가 목적이고, 목적이 끝나면 값도 끝난다.
  // 필명 플랫폼이라 실명이 다른 화면으로 새면 필명의 의미가 사라진다
  const ids = [...new Set([...mismatches, ...cooldowns].map((r) => r.researcherUserId))];
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, penName: true, email: true },
  });
  const name = new Map(users.map((u) => [u.id, u.penName ?? u.email]));

  // 동결에 묶인 금액 — "누가 얼마나"의 얼마나
  const heldByUser = new Map<string, number>();
  if (frozen.length > 0) {
    const rows = await prisma.settlement.findMany({
      where: {
        payoutExecutedAt: null,
        purchase: {
          report: { researcher: { userId: { in: frozen.map((f) => f.researcherUserId) } } },
        },
      },
      select: {
        researcherPayoutKrw: true,
        purchase: { select: { report: { select: { researcher: { select: { userId: true } } } } } },
      },
    });
    for (const r of rows) {
      const uid = r.purchase.report.researcher.userId;
      heldByUser.set(uid, (heldByUser.get(uid) ?? 0) + r.researcherPayoutKrw);
    }
  }

  return {
    frozen: frozen.map((f) => ({
      ...f,
      heldKrw: heldByUser.get(f.researcherUserId) ?? 0,
      days: Math.floor((now.getTime() - new Date(f.frozenAt).getTime()) / 86_400_000),
    })),
    mismatches: mismatches.map((m) => ({
      researcherUserId: m.researcherUserId,
      displayName: name.get(m.researcherUserId) ?? m.researcherUserId,
      account: `${m.bankCode} ···${m.accountLast4}`,
      bankHolder: m.holderName ?? '—',
      verifiedName: m.verifiedNameEnc ? decryptField(m.verifiedNameEnc) : '—',
    })),
    cooldowns: cooldowns.map((c) => ({
      researcherUserId: c.researcherUserId,
      displayName: name.get(c.researcherUserId) ?? c.researcherUserId,
      account: `···${c.accountLast4}`,
      changedAt: c.createdAt,
      until: c.cooldownUntil!,
      hoursLeft: Math.max(0, Math.ceil((c.cooldownUntil!.getTime() - now.getTime()) / 3_600_000)),
    })),
    signals,
    signalWindowDays: SIGNAL_WINDOW_DAYS,
  };
}
