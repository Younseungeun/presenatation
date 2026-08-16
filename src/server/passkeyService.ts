import type { PrismaClient } from '@prisma/client';
import { notifyNewDevice } from './deviceService';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

// 패스키(생체) 로그인 — **기기에 묶인 열쇠로 평소 로그인을 대신한다.**
//
// ── 왜 만드나 ───────────────────────────────────────────────────
// 지금까지 로그인은 매번 본인 인증이었다(authService.verifyAndSignIn). 실공급자를
// 붙이는 순간 그것이 **앱을 열 때마다 나가는 비용**이 되고, 사용자는 매번 이름과
// 번호를 적는다. 하루에 몇 번 들어오는 사람에게는 그때마다 관문이다.
//
// 그리고 방어의 축이 하나 늘어난다. 본인 인증도 문자 알림도 **폰 번호**에 걸려 있어
// 유심을 가로채이면 함께 무너지는데, 패스키는 기기 안의 열쇠라 번호와 무관하다.
//
// ── 무엇을 대신하고 무엇을 대신하지 않나 ────────────────────────
//   대신한다      평소 로그인 (앱 열기, 읽기·쓰기·구매·판매)
//   대신 못 한다  **계좌 등록·변경** — 거기는 이름이 필요하다.
//                 패스키는 "같은 기기"를 증명할 뿐 **이름을 모른다**
//
// ── 생체 정보는 우리에게 오지 않는다 ────────────────────────────
// 지문·얼굴은 기기 밖으로 나가지 않는다. 기기가 그것으로 로컬 열쇠를 열고 **서명**만
// 만들어 보낸다. 우리가 보관하는 것은 공개키라, 이 표가 통째로 새어도 남의 계정으로
// 로그인할 수 없다(공개키로는 서명을 만들 수 없다).
//
// ── 직접 구현하지 않는다 ────────────────────────────────────────
// 서명 검증에는 CBOR 파싱·COSE 키 해석·서명 알고리즘 분기가 들어간다. 여기서 실수하면
// **틀린 서명을 통과시키면서도 테스트는 초록불**이다. `@simplewebauthn/server`를 쓴다.

export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/**
 * 챌린지 유효 시간.
 *
 * 사용자가 지문에 손을 대기까지의 시간이라 짧아도 된다. 길게 두면 가로챈 챌린지를
 * 쓸 수 있는 창이 그만큼 넓어진다.
 *
 * @근거 설계 사람이 지문에 손을 대는 시간 — 창을 넓힐 이유가 없다
 */
export const CHALLENGE_TTL_MS = 3 * 60_000;

/**
 * 한 사람이 등록할 수 있는 기기 수.
 *
 * 폰·태블릿·노트북까지가 현실적인 상한이고, 그 위는 **탈취자가 조용히 하나 더 심어
 * 두는 자리**가 된다. 넘으면 오래된 것을 지우고 등록하게 한다(자동으로 지우지 않는다 —
 * 어느 기기를 버릴지는 본인이 알아야 하는 일이다).
 *
 * @근거 설계 폰·태블릿·노트북 — 그 위는 탈취자가 하나 더 심어 두는 자리가 된다
 */
export const MAX_PASSKEYS_PER_USER = 5;

/**
 * 사이트 식별자. 패스키는 이 값에 묶이므로 **도메인이 바뀌면 등록된 열쇠가 전부 무효**가 된다.
 *
 * 운영에서 값이 없으면 **던진다.** 조용히 localhost로 물러서면 배포된 서버에서 등록은
 * 되는데 로그인이 안 되는 상태가 되고, 그 증상은 "가끔 로그인이 안 돼요"로 들어온다 —
 * 원인을 찾는 데 가장 오래 걸리는 종류의 실패다. (PAYOUT_ENC_KEY와 같은 규칙)
 */
export function relyingParty(env = process.env): { id: string; name: string; origin: string } {
  const origin = env.NEXT_PUBLIC_APP_ORIGIN;
  if (!origin) {
    if (env.NODE_ENV === 'production') {
      throw new Error('운영 환경에는 NEXT_PUBLIC_APP_ORIGIN이 반드시 있어야 합니다 (패스키가 이 값에 묶인다)');
    }
    return { id: 'localhost', name: 'INTOVILL', origin: 'http://localhost:3000' };
  }
  return { id: new URL(origin).hostname, name: 'INTOVILL', origin };
}

/**
 * 브라우저가 보낸 clientDataJSON에서 챌린지를 꺼낸다.
 *
 * **이 값 자체는 신뢰하지 않는다.** 이걸로 DB를 조회해서 "우리가 발급한 것이 맞는지"를
 * 확인하는 것이 검사이고, 지어낸 값은 조회에서 걸린다. 꺼내는 이유는 단지 어느 챌린지에
 * 대한 응답인지 알아내기 위해서다.
 */
function challengeFrom(clientDataJSON: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString());
    if (typeof parsed?.challenge !== 'string') throw new Error();
    return parsed.challenge;
  } catch {
    throw new PasskeyError('요청 형식이 올바르지 않습니다');
  }
}

async function issueChallenge(
  prisma: PrismaClient,
  challenge: string,
  purpose: 'REGISTER' | 'LOGIN',
  userId: string | null,
  now: Date,
): Promise<void> {
  await prisma.webAuthnChallenge.create({
    data: { challenge, purpose, userId, expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS) },
  });
}

/**
 * 챌린지를 **쓰면서 지운다** — 재사용을 막는 것이 이 함수의 전부다.
 *
 * `deleteMany`의 반환 건수로 판단하는 이유: 조회 후 삭제로 나누면 두 요청이 같은
 * 챌린지를 동시에 통과할 수 있다. 삭제가 성공한 쪽만 그 챌린지의 주인이다.
 */
async function consumeChallenge(
  prisma: PrismaClient,
  challenge: string,
  purpose: 'REGISTER' | 'LOGIN',
  now: Date,
): Promise<{ userId: string | null }> {
  const row = await prisma.webAuthnChallenge.findUnique({ where: { challenge } });
  const { count } = await prisma.webAuthnChallenge.deleteMany({ where: { challenge } });
  if (!row || count === 0) throw new PasskeyError('만료되었거나 이미 사용된 요청입니다');
  if (row.purpose !== purpose) throw new PasskeyError('요청 종류가 맞지 않습니다');
  if (row.expiresAt.getTime() < now.getTime()) throw new PasskeyError('시간이 지났습니다 — 다시 시도해주세요');
  return { userId: row.userId };
}

/** 지나간 챌린지 청소 (스케줄러가 부른다). 남겨 둬도 위험하진 않지만 표가 자란다 */
export async function purgeExpiredChallenges(prisma: PrismaClient, now = new Date()): Promise<number> {
  const { count } = await prisma.webAuthnChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}

// ── 등록 ────────────────────────────────────────────────────────

export async function startPasskeyRegistration(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { penName: true, email: true, passkeys: { select: { credentialId: true } } },
  });
  if (!user) throw new PasskeyError('사용자를 찾을 수 없습니다');
  if (user.passkeys.length >= MAX_PASSKEYS_PER_USER) {
    throw new PasskeyError(
      `등록할 수 있는 기기는 ${MAX_PASSKEYS_PER_USER}대까지입니다 — 쓰지 않는 기기를 먼저 지워주세요.`,
    );
  }

  const rp = relyingParty();
  const options = await generateRegistrationOptions({
    rpID: rp.id,
    rpName: rp.name,
    userName: user.penName ?? user.email,
    // 이미 등록된 기기에서 또 등록하면 같은 열쇠가 두 줄이 된다 — 인증기가 스스로 막게 한다
    excludeCredentials: user.passkeys.map((p) => ({ id: p.credentialId })),
    authenticatorSelection: {
      // **기기에 내장된 인증기만** — 보안키(USB)까지 열면 "지문으로 간편하게"라는
      // 목적에서 멀어지고, 잃어버렸을 때의 복구 경로도 하나 더 늘어난다
      authenticatorAttachment: 'platform',
      // 사용자 확인을 요구한다 = **지문·얼굴·기기 PIN 중 하나를 반드시 거친다.**
      // 이것이 없으면 잠금 해제된 기기를 집어든 사람이 그대로 로그인한다
      userVerification: 'required',
      residentKey: 'preferred',
    },
    // 인증기 제조사 증명은 받지 않는다 — 검증 부담과 개인정보(기기 식별)만 늘고,
    // 우리가 "어느 회사 칩인지"로 무엇을 결정할 일이 없다
    attestationType: 'none',
  });

  await issueChallenge(prisma, options.challenge, 'REGISTER', userId, now);
  return options;
}

export async function finishPasskeyRegistration(
  prisma: PrismaClient,
  input: { userId: string; response: RegistrationResponseJSON; label: string },
  now = new Date(),
): Promise<{ credentialId: string; label: string; isFirst: boolean }> {
  const challenge = challengeFrom(input.response.response.clientDataJSON);
  const { userId } = await consumeChallenge(prisma, challenge, 'REGISTER', now);
  // 챌린지는 발급받은 그 사람만 쓸 수 있다 — 남의 챌린지로 내 계정에 열쇠를 심지 못한다
  if (userId !== input.userId) throw new PasskeyError('요청한 사용자와 다릅니다');

  const rp = relyingParty();
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new PasskeyError('기기 등록을 확인하지 못했습니다');
  }

  const { credential } = verification.registrationInfo;
  const before = await prisma.passkey.count({ where: { userId: input.userId } });

  await prisma.passkey.create({
    data: {
      userId: input.userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      label: input.label.trim().slice(0, 40) || '내 기기',
      createdAt: now,
    },
  });

  // ── 기기 등록은 **계좌 변경과 같은 무게의 사건이다** ─────────────
  // "새 사람이 이 계정을 쓰기 시작했다"는 뜻이라, 조용히 지나가면 탈취자가 여기로
  // 들어온다. 첫 등록(가입 직후)은 본인이 방금 한 일이라 알리지 않는다
  await notifyNewDevice(
    prisma,
    { userId: input.userId, label: input.label, kind: 'BIOMETRIC' },
    now,
  );

  return { credentialId: credential.id, label: input.label, isFirst: before === 0 };
}

// ── 로그인 ──────────────────────────────────────────────────────

export async function startPasskeyLogin(prisma: PrismaClient, now = new Date()) {
  const rp = relyingParty();
  // **누구인지 묻지 않는다.** 이메일이나 번호를 먼저 받으면 "그 번호가 가입돼 있는지"가
  // 응답에서 드러난다. 기기가 자기가 가진 열쇠 중에서 고르게 두면 그 누출이 없다
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: 'required',
  });
  await issueChallenge(prisma, options.challenge, 'LOGIN', null, now);
  return options;
}

export async function finishPasskeyLogin(
  prisma: PrismaClient,
  response: AuthenticationResponseJSON,
  now = new Date(),
): Promise<{ userId: string }> {
  const challenge = challengeFrom(response.response.clientDataJSON);
  await consumeChallenge(prisma, challenge, 'LOGIN', now);

  const stored = await prisma.passkey.findUnique({ where: { credentialId: response.id } });
  if (!stored) throw new PasskeyError('등록되지 않은 기기입니다');

  const rp = relyingParty();
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: true,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
      counter: stored.counter,
    },
  });
  if (!verification.verified) throw new PasskeyError('로그인을 확인하지 못했습니다');

  // ── 카운터가 되돌아가면 **복제된 인증기**다 ──────────────────
  // 정상 인증기는 서명할 때마다 카운터를 올린다. 줄어들었다는 것은 같은 열쇠가 두
  // 곳에 있다는 뜻이다. 다만 애플·구글의 기기 내장 인증기는 **0으로 고정**해서 보내므로
  // (동기화되는 패스키라 카운터가 의미를 잃는다) 0일 때는 검사하지 않는다
  const next = verification.authenticationInfo.newCounter;
  if (stored.counter > 0 && next > 0 && next <= stored.counter) {
    throw new PasskeyError('기기 확인에 실패했습니다 — 운영자에게 문의해주세요');
  }

  await prisma.passkey.update({
    where: { credentialId: stored.credentialId },
    data: { counter: next, lastUsedAt: now },
  });
  return { userId: stored.userId };
}

// ── 관리 ────────────────────────────────────────────────────────

export async function listPasskeys(prisma: PrismaClient, userId: string) {
  return prisma.passkey.findMany({
    where: { userId },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * 기기를 지운다.
 *
 * **마지막 한 대도 지울 수 있게 둔다.** 남겨 두면 잃어버린 기기를 못 지우게 되는데,
 * 그건 "쓸 수 없는 열쇠가 계정에 계속 붙어 있는" 상태다. 전부 지워도 본인 인증으로
 * 다시 들어올 수 있으므로 잠기지 않는다.
 */
export async function removePasskey(
  prisma: PrismaClient,
  input: { userId: string; passkeyId: string },
  now = new Date(),
): Promise<void> {
  // 조건에 userId가 들어가야 남의 기기를 못 지운다 — id만으로 찾으면 그 자체가 창구다
  const target = await prisma.passkey.findFirst({
    where: { id: input.passkeyId, userId: input.userId },
    select: { label: true },
  });
  if (!target) throw new PasskeyError('등록된 기기가 아닙니다');
  await prisma.passkey.delete({ where: { id: input.passkeyId } });

  // **지우는 것도 알린다.** 탈취자가 진짜 주인의 열쇠를 지우고 자기 것만 남기면,
  // 주인은 생체 로그인이 안 되는 이유를 모른 채 본인 인증으로 들어온다 — 그때 이 알림이
  // 없으면 "왜 안 되지"로 끝나고 사고가 사고인 줄 모른 채 지나간다
  await prisma.notification.create({
    data: {
      userId: input.userId,
      type: 'PASSKEY_REMOVED',
      title: '로그인 기기가 삭제되었습니다',
      body:
        `"${target.label}"에서 더 이상 지문·얼굴로 로그인할 수 없습니다.\n` +
        '**본인이 삭제하지 않았다면 정산을 동결해주세요.**',
      link: '/settings/payout',
      createdAt: now,
    },
  });
}
