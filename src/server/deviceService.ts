import type { PrismaClient } from '@prisma/client';

// 로그인 기기 관리 — **두 종류를 한 목록으로 본다** (2026-08-16 검토 2차 Q1 보완).
//
// 생체(Passkey)와 간편 비밀번호(TrustedDevice)는 저장 구조가 다르지만, 사용자에게는
// 똑같이 "내 계정에 들어올 수 있는 기기"다. 나눠서 보여 주면 잃어버린 폰을 지우려는
// 사람이 **한쪽만 지우고 안심**하게 된다 — 그게 이 화면에서 가장 비싼 실수다.
//
// ── 지우는 것만으로는 부족하다 ────────────────────────────────
// 기기를 지워도 **이미 살아 있는 세션**은 그대로다. 그래서 지울 때 세션 세대를 올려
// 그 계정의 모든 세션을 함께 끊는다(강제 로그아웃). 본인은 다시 들어오면 되고,
// 훔친 쪽은 자격증명이 없으니 못 들어온다.

export type LoginDevice = {
  id: string;
  kind: 'BIOMETRIC' | 'PIN';
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** 간편 비밀번호가 잠긴 기기 — 목록에서 그 사실이 보여야 한다 */
  locked: boolean;
};

export async function listLoginDevices(
  prisma: PrismaClient,
  userId: string,
): Promise<LoginDevice[]> {
  const [passkeys, trusted] = await Promise.all([
    prisma.passkey.findMany({
      where: { userId },
      select: { id: true, label: true, createdAt: true, lastUsedAt: true },
    }),
    prisma.trustedDevice.findMany({
      where: { userId },
      select: { id: true, label: true, createdAt: true, lastUsedAt: true, lockedAt: true },
    }),
  ]);

  return [
    ...passkeys.map((p) => ({
      id: p.id,
      kind: 'BIOMETRIC' as const,
      label: p.label,
      createdAt: p.createdAt.toISOString(),
      lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
      locked: false,
    })),
    ...trusted.map((t) => ({
      id: t.id,
      kind: 'PIN' as const,
      label: t.label,
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      locked: t.lockedAt !== null,
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * **모든 세션을 끊는다** — 세대를 올리면 낮은 세대로 서명된 토큰이 전부 죽는다.
 *
 * 기기 삭제와 짝이다: 지우기만 하면 그 기기의 **다음** 로그인을 막을 뿐,
 * 지금 열려 있는 창은 그대로 남는다.
 */
export async function revokeAllSessions(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sessionEpoch: { increment: 1 } },
  });
}

/**
 * 기기를 지운다 — 생체·간편 어느 쪽이든.
 *
 * **마지막 한 대도 지울 수 있다.** 남겨 두면 잃어버린 기기를 못 지우게 되는데,
 * 그것은 "쓸 수 없는 열쇠가 계정에 계속 붙어 있는" 상태다. 전부 지워도 본인 인증으로
 * 다시 들어올 수 있으므로 계정이 잠기지 않는다.
 */
export async function removeLoginDevice(
  prisma: PrismaClient,
  input: { userId: string; deviceId: string; kind: 'BIOMETRIC' | 'PIN' },
  now = new Date(),
): Promise<{ label: string }> {
  // 조건에 userId가 들어가야 남의 기기를 못 지운다 — id만으로 찾으면 그 자체가 창구다
  const where = { id: input.deviceId, userId: input.userId };
  const target =
    input.kind === 'BIOMETRIC'
      ? await prisma.passkey.findFirst({ where, select: { label: true } })
      : await prisma.trustedDevice.findFirst({ where, select: { label: true } });
  if (!target) throw new Error('등록된 기기가 아닙니다');

  if (input.kind === 'BIOMETRIC') {
    await prisma.passkey.delete({ where: { id: input.deviceId } });
  } else {
    await prisma.trustedDevice.delete({ where: { id: input.deviceId } });
  }

  // 지운 기기가 아직 열어 둔 창을 함께 닫는다
  await revokeAllSessions(prisma, input.userId);

  await prisma.notification.create({
    data: {
      userId: input.userId,
      type: 'DEVICE_REMOVED',
      title: '로그인 기기가 삭제되었습니다',
      body:
        `"${target.label}"에서 더 이상 로그인할 수 없습니다.\n` +
        '모든 기기에서 로그아웃되었습니다 — 본인 기기에서는 다시 로그인해주세요.\n' +
        '**본인이 삭제하지 않았다면 정산을 동결해주세요.**',
      link: '/settings/payout',
      createdAt: now,
    },
  });
  return target;
}

/**
 * **새 기기가 붙었다고 기존 기기들에 알린다.**
 *
 * 유심을 가로챈 공격자가 간편 비밀번호를 심으면, 그것이 주는 것은 추가 권한이 아니라
 * **지속성**이다 — 유심을 돌려준 뒤에도 그 기기로 계속 들어온다. 그 사실을 진짜
 * 주인이 아는 유일한 경로가 이 알림이고, 알아챈 사람이 쓰는 것이 기기 삭제다.
 *
 * 첫 기기(가입 직후)는 알리지 않는다 — 본인이 방금 한 일이고, 알릴 상대도 없다.
 */
export async function notifyNewDevice(
  prisma: PrismaClient,
  input: { userId: string; label: string; kind: 'BIOMETRIC' | 'PIN' },
  now = new Date(),
): Promise<boolean> {
  const [passkeys, trusted] = await Promise.all([
    prisma.passkey.count({ where: { userId: input.userId } }),
    prisma.trustedDevice.count({ where: { userId: input.userId } }),
  ]);
  if (passkeys + trusted <= 1) return false;

  const kindLabel = input.kind === 'BIOMETRIC' ? '지문·얼굴 로그인' : '간편 비밀번호';
  await prisma.notification.create({
    data: {
      userId: input.userId,
      type: 'DEVICE_ADDED',
      title: '[중요] 새 기기에서 로그인이 설정되었습니다',
      body:
        `"${input.label}"에 ${kindLabel}이 설정되었습니다. 이제 그 기기에서 이 계정에 들어올 수 있습니다.\n` +
        '본인이 새 기기를 쓰기 시작하신 것이라면 그대로 두셔도 됩니다.\n' +
        '**본인이 아니라면 [설정 → 로그인 기기]에서 그 기기를 삭제하고 정산을 동결해주세요.**',
      link: '/settings/devices',
      createdAt: now,
    },
  });
  return true;
}
