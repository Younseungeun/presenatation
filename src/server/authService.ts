import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RESEARCHER_REQUIRED_DOCS, SIGNUP_REQUIRED_DOCS } from '@/domain/legalDocs';
import { encryptField } from './fieldCrypto';
import { recordConsents } from './consentService';
import type { IdentityProvider, IdentityVerificationInput } from './identityProvider';

// 본인 인증 + 1인 1계정 강제.
// CI는 절대 원문 저장하지 않고 서버 pepper로 HMAC 해시해 identityHash(unique)로만 보관한다.
// 같은 사람(=같은 CI)은 항상 같은 계정으로 매핑되므로, 계정을 다시 만들어 성적을
// 세탁하려는 시도가 원천 차단된다 (CLAUDE.md §2.4).

/**
 * CI 해시에 섞는 비밀 — **운영에서 값이 없으면 던진다** (2026-08-18 전수 점검).
 *
 * 폴백 값은 저장소에 적혀 있어 공개나 다름없다. 운영에서 이 값으로 물러서면
 * "같은 사람 = 같은 계정" 판정의 기준값을 남이 만들어 볼 수 있게 되는데, 아무
 * 경고가 없어 잊은 채 배포해도 겉보기에는 멀쩡히 돈다.
 * AUTH_SECRET·PAYOUT_ENC_KEY와 같은 규칙 — 호출 시점 검사라 빌드는 env 없이 돈다.
 */
export function identityPepper(env = process.env): string {
  const v = env.IDENTITY_PEPPER;
  if (v) return v;
  if (env.NODE_ENV === 'production') {
    throw new Error('운영 환경에는 IDENTITY_PEPPER가 반드시 있어야 합니다 (신원 해시 비밀 — 없으면 코드에 적힌 개발용 값으로 물러선다)');
  }
  return 'dev-identity-pepper';
}

export function hashCi(ci: string): string {
  return createHmac('sha256', identityPepper()).update(ci).digest('hex');
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

  // ── 관리자는 계정이 아니라 **신원**이다 (2026-08-17 사용자 확정 구조) ────
  // 창업자의 CI 해시를 환경 변수에 고정해 두면, **그 사람의 본인 인증**이 곧 관리자
  // 승격이다 — 어느 기기, 어느 계정 행이든 상관없다. DB의 role 칸을 CLI로 부여하는
  // 방식(op:grant)과 달리, 앱을 다시 깔거나 DB를 초기화해도 풀 로그인 한 번이면
  // 관리자 화면이 돌아온다. 값을 코드가 아니라 환경 변수에 두는 이유: 코드는 원격
  // 저장소에 올라가고, 한 번 올라간 값은 이력에서 지워지지 않는다.
  // **승격만 한다** — 환경 변수가 비어 있거나 다르면 아무 일도 하지 않는다.
  const founderHash = process.env.FOUNDER_CI_HASH?.trim();
  const isFounder = !!founderHash && identityHash === founderHash;

  // ── 실명을 가입 시점에 저장한다 (2026-08-16 사용자 확정) ─────────
  // 계좌 등록 때 은행 예금주명과 대조할 상대편이다. 인증 응답의 이름만 쓴다 —
  // 본인이 화면에 적는 이름은 절대 이 칸에 들어오지 않는다.
  // 풀 로그인마다 갱신하는 이유: 개명한 사람의 통장은 새 이름이라, 옛 이름을
  // 들고 있으면 정당한 본인이 예금주 불일치로 막힌다.
  const realNameEnc = encryptField(result.name);

  const existing = await prisma.user.findUnique({ where: { identityHash } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        realNameEnc,
        ...(isFounder && existing.role !== 'OPERATOR'
          ? { role: 'OPERATOR', operatorCold: false }
          : {}),
      },
    });
    return { userId: existing.id, isNewUser: false };
  }

  // 이메일은 아직 수집하지 않으므로 계정마다 고유한 플레이스홀더를 둔다 (unique 제약 충족)
  const created = await prisma.user.create({
    data: {
      email: `${identityHash.slice(0, 24)}@identity.local`,
      penName: input.penName?.trim() || null,
      identityVerified: true,
      identityHash,
      realNameEnc,
      ...(isFounder ? { role: 'OPERATOR' } : {}),
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
