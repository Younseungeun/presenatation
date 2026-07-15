import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { IdentityProvider, IdentityVerificationInput } from './identityProvider';

// 본인 인증 + 1인 1계정 강제.
// CI는 절대 원문 저장하지 않고 서버 pepper로 HMAC 해시해 identityHash(unique)로만 보관한다.
// 같은 사람(=같은 CI)은 항상 같은 계정으로 매핑되므로, 계정을 다시 만들어 성적을
// 세탁하려는 시도가 원천 차단된다 (CLAUDE.md §2.4).

const IDENTITY_PEPPER = process.env.IDENTITY_PEPPER ?? 'dev-identity-pepper';

export function hashCi(ci: string): string {
  return createHmac('sha256', IDENTITY_PEPPER).update(ci).digest('hex');
}

export interface VerifyAndSignInInput extends IdentityVerificationInput {
  /** 신규 가입 시 사용할 필명 (기존 계정이면 무시) */
  penName?: string;
}

export interface SignInResult {
  userId: string;
  isNewUser: boolean;
}

/**
 * 본인 인증 후 로그인. CI 해시로 기존 계정을 찾으면 그 계정으로 로그인하고,
 * 없으면 새 계정을 만든다. 어느 경우든 1인 1계정이 유지된다.
 */
export async function verifyAndSignIn(
  prisma: PrismaClient,
  provider: IdentityProvider,
  input: VerifyAndSignInInput,
): Promise<SignInResult> {
  const result = await provider.verify(input);
  const identityHash = hashCi(result.ci);

  const existing = await prisma.user.findUnique({ where: { identityHash } });
  if (existing) {
    return { userId: existing.id, isNewUser: false };
  }

  // 이메일은 아직 수집하지 않으므로 계정마다 고유한 플레이스홀더를 둔다 (unique 제약 충족)
  const created = await prisma.user.create({
    data: {
      email: `${identityHash.slice(0, 24)}@identity.local`,
      penName: input.penName?.trim() || null,
      identityVerified: true,
      identityHash,
    },
  });
  return { userId: created.id, isNewUser: true };
}

/** 현재 사용자를 리서처로 전환 (프로필 생성, 멱등) */
export async function ensureResearcherProfile(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { researcherProfile: true },
  });
  if (!user.identityVerified) {
    throw new Error('본인 인증 후 리서처로 활동할 수 있습니다');
  }
  if (user.researcherProfile) return user.researcherProfile;
  return prisma.researcherProfile.create({ data: { userId } });
}
