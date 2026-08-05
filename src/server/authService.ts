import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RESEARCHER_REQUIRED_DOCS, SIGNUP_REQUIRED_DOCS } from '@/domain/legalDocs';
import { recordConsents } from './consentService';
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

/**
 * 가입 갈래 — 리포트를 사는 이용자(USER) / 쓰는 리서처(RESEARCHER).
 * 되돌릴 수 없는 선택이 아니다: USER로 시작해도 MY에서 리서처로 전환할 수 있고,
 * 리서처가 구매자로 활동하는 것도 막지 않는다. 가입 시점 선택은 첫 화면과
 * 받아야 할 동의(리서처 이용계약)를 정하는 역할이다.
 */
export type AccountType = 'USER' | 'RESEARCHER';

export interface SignUpInput extends VerifyAndSignInInput {
  accountType?: AccountType;
}

export interface SignUpResult extends SignInResult {
  /** 리서처로 시작했으면 생성(또는 기존)된 프로필 id */
  researcherId: string | null;
}

/**
 * 본인 인증 → 로그인 → (선택) 리서처 전환 → 동의 이력 기록까지 한 번에.
 * 라우트가 얇아지고, 갈래별 부수효과를 한자리에서 검증할 수 있다.
 * 동의 문구 검증(체크박스 필수)은 입력 단계인 라우트가 담당한다.
 */
export async function signUpAndSignIn(
  prisma: PrismaClient,
  provider: IdentityProvider,
  input: SignUpInput,
): Promise<SignUpResult> {
  const result = await verifyAndSignIn(prisma, provider, input);
  // 현재 버전 필수 약관 동의 이력 (같은 버전 중복은 기록하지 않음)
  await recordConsents(prisma, result.userId, SIGNUP_REQUIRED_DOCS, 'SIGNUP');

  if (input.accountType !== 'RESEARCHER') {
    return { ...result, researcherId: null };
  }
  // 프로필 생성은 멱등 — 이미 리서처인 계정으로 다시 들어와도 안전하다
  const profile = await ensureResearcherProfile(prisma, result.userId);
  await recordConsents(prisma, result.userId, RESEARCHER_REQUIRED_DOCS, 'RESEARCHER_ACTIVATION');
  return { ...result, researcherId: profile.id };
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
