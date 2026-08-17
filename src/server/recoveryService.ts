import { Prisma, type PrismaClient } from '@prisma/client';
import { auditOp } from './auditLog';
import { notifyOperators } from './opsAlert';
import { RecoveryError, verifyRecoveryToken } from './recoveryToken';

// 종이 열쇠 사용처 — **표를 태우고, 딱 하나의 권한만 연다** (2026-08-17 검토 7차 Q1).
//
// 설계 근거는 recoveryToken.ts에 있다. 여기서 지키는 것은 세 가지다:
//
//   ① 꺼져 있는 것이 기본이다   공개키나 창업자 신원 해시가 없으면 이 경로는 **없다**
//   ② 대상은 창업자 하나뿐이다  표에 적힌 계정이 FOUNDER_CI_HASH의 주인이 아니면 거절
//   ③ 표는 한 번만 쓴다         nonce를 태우고, 태우기에 실패하면 실행하지 않는다
//
// ②가 있는 이유: 표만 위조하면 아무 계정이나 열리는 구조였다면, 종이 열쇠가
// **모든 사용자의 계정 복구 도구**가 된다. 종이는 창업자 계정 하나만 연다.

export async function redeemRecoveryToken(
  prisma: PrismaClient,
  input: { token: string; note?: string },
  now = new Date(),
  // 시험이 process.env를 통째로 흉내 내지 않아도 되게 — 읽는 것은 아래 두 값뿐이다
  env: Record<string, string | undefined> = process.env,
): Promise<{ userId: string }> {
  const publicKey = env.RECOVERY_PUBLIC_KEY?.trim();
  const founderHash = env.FOUNDER_CI_HASH?.trim();
  // 둘 중 하나라도 없으면 이 기능은 **설정되지 않은 것**이다. 반쯤 켜진 상태로
  // 두면 "공개키는 있는데 대상 확인이 없는" 가장 위험한 조합이 만들어진다
  if (!publicKey || !founderHash) {
    throw new RecoveryError('비상 복구가 설정되어 있지 않습니다', 'DISABLED');
  }

  const claims = verifyRecoveryToken(input.token, publicKey, now.getTime());

  const user = await prisma.user.findUnique({
    where: { email: claims.email },
    select: { id: true, identityHash: true },
  });
  // 계정이 없는 것과 창업자가 아닌 것을 **같은 말로** 돌려준다 — 다르게 답하면
  // 이 창구가 "이 이메일이 창업자입니까"를 묻는 조회기가 된다
  if (!user || !user.identityHash || user.identityHash !== founderHash) {
    throw new RecoveryError('복구 표가 올바르지 않거나 기간이 지났습니다');
  }

  // **표를 먼저 태운다.** 태우는 데 성공한 요청만 이 표의 주인이다 — 같은 표를 동시에
  // 낸 둘이 있으면 유니크 제약이 한쪽을 떨어뜨린다. 감사 기록을 같은 트랜잭션에 묶어
  // "권한은 열렸는데 기록은 없는" 창을 만들지 않는다
  try {
    await prisma.$transaction([
      // **복구를 쓴 사실을 계정에 새긴다** — 이 자국이 48시간 동안 돈을 붙잡는다.
      // 금고의 종이를 훔친 사람도 여기서 자기 지문을 등록할 수 있기 때문이다
      prisma.user.update({ where: { id: user.id }, data: { recoveredAt: now } }),
      prisma.recoveryUse.create({
        data: {
          nonce: claims.nonce,
          usedAt: now,
          targetUserId: user.id,
          note: input.note?.trim() || null,
        },
      }),
      auditOp(prisma, {
        actor: user.id,
        actorType: 'OPERATOR',
        action: 'RECOVERY_GRANTED',
        targetType: 'User',
        targetId: user.id,
        after: { grant: 'PASSKEY_REGISTER_ONLY', expiresAt: claims.expiresAt },
        reason: input.note?.trim() || '사유 미기재',
        at: now,
      }),
    ]);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new RecoveryError('이미 사용된 복구 표입니다 — 새로 서명해주세요', 'USED');
    }
    throw e;
  }

  // 알림은 실패해도 복구를 막지 않는다(opsAlert가 삼킨다). 다만 **반드시 시도한다** —
  // 금고가 열린 사실을 본인이 모르는 채로 지나가면 안 된다
  await notifyOperators(prisma, {
    title: '[중대] 비상 복구(종이 열쇠)가 사용되었습니다',
    body: [
      '금고 속 종이 열쇠로 서명된 복구 표가 사용되어, 이 기기에 패스키를 등록할 수 있게 열렸습니다.',
      `사유: ${input.note?.trim() || '미기재'}`,
      '앞으로 48시간 동안 돈을 내보내는 기능(동결 해제·지급·수동 판정·이의 인정·보상)은 멈춥니다.',
      '**본인이 금고를 연 것이 아니라면 지금 즉시 종이 열쇠를 폐기하고 공개키를 교체하세요.**',
    ].join('\n'),
    link: '/admin',
  });

  return { userId: user.id };
}
