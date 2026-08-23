import type { PrismaClient } from '@prisma/client';

// 동결 상세 — **해제 판단의 재료를 한 화면에 모은다** (시안 v3 scr-frozen).
//
// 목록은 "누가 얼마나"까지만 답한다. 풀지 말지를 정하려면 **그때 무슨 일이 있었나**를
// 알아야 하는데, 그 재료가 지금까지 세 표에 흩어져 있어 운영자가 DB를 열어야 했다.
//
// 가장 중요한 한 줄: **계좌가 바뀐 직후에 동결이 걸렸는가.** 그렇다면 진짜 신호였을
// 가능성이 높다 — 본인이 "제가 바꿨다"고 해도 그 말을 **어느 경로로 들었는지**가
// 판단의 재료지, 앱 안에서 읽은 글은 본인 증명이 아니다.

/**
 * @근거 설계 계좌 변경과 동결이 **같은 사건**인지 가르는 창.
 * 넓게 잡으면 무관한 변경까지 "직후"로 읽히고, 좁게 잡으면 알림을 보고 허둥대다
 * 몇 분 늦게 누른 진짜 신호를 놓친다. 알림 확인 → 앱 열기 → 동결까지의 시간이다
 */
export const FREEZE_LINK_WINDOW_MIN = 30;

export async function getFrozenDetail(
  prisma: PrismaClient,
  researcherUserId: string,
  now = new Date(),
) {
  const account = await prisma.payoutAccount.findUnique({ where: { researcherUserId } });
  if (!account?.frozenAt) return null;

  const [user, history, settlements, passkeys, devices] = await Promise.all([
    prisma.user.findUnique({
      where: { id: researcherUserId },
      select: { penName: true, email: true, identityVerified: true },
    }),
    prisma.payoutAccountHistory.findMany({
      where: { researcherUserId },
      orderBy: { recordedAt: 'desc' },
    }),
    prisma.settlement.findMany({
      where: {
        payoutExecutedAt: null,
        purchase: { report: { researcher: { userId: researcherUserId } } },
      },
      select: { researcherPayoutKrw: true },
    }),
    prisma.passkey.count({ where: { userId: researcherUserId } }),
    prisma.trustedDevice.count({ where: { userId: researcherUserId } }),
  ]);

  const frozenAt = account.frozenAt;
  // **동결 직전의 계좌 변경** — 이 한 줄이 "진짜 신호였나"의 답에 가장 가깝다
  const before = new Date(frozenAt.getTime() - FREEZE_LINK_WINDOW_MIN * 60_000);
  const justBefore = history.find((h) => h.recordedAt >= before && h.recordedAt <= frozenAt);
  const after = history.filter((h) => h.recordedAt > frozenAt);

  return {
    researcherUserId,
    displayName: user?.penName ?? user?.email ?? researcherUserId,
    frozenAt,
    frozenBySelf: account.frozenBy === researcherUserId,
    days: Math.floor((now.getTime() - frozenAt.getTime()) / 86_400_000),
    account: {
      label:
        account.accountNumberEnc === ''
          ? '계좌 미등록 (선제 동결)'
          : `${account.bankCode} ···${account.accountLast4}`,
      status: account.status,
      // 유예가 걸려 있었다는 것은 **낯선 기기에서 바꿨다**는 뜻이다
      cooldownUntil: account.cooldownUntil,
    },
    heldKrw: settlements.reduce((s, r) => s + r.researcherPayoutKrw, 0),
    heldCount: settlements.length,
    /** 동결 직전에 계좌가 바뀌었나 — 있으면 그 시각과 간격(분) */
    changedJustBefore: justBefore
      ? {
          at: justBefore.recordedAt,
          minutesBefore: Math.max(
            0,
            Math.round((frozenAt.getTime() - justBefore.recordedAt.getTime()) / 60_000),
          ),
          fromUnknownDevice: account.cooldownUntil !== null,
        }
      : null,
    changedAfter: after.length,
    identityVerified: user?.identityVerified ?? false,
    historyCount: history.length,
    passkeys,
    devices,
  };
}
