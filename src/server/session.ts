import { cookies } from 'next/headers';
import { prisma } from './db';
import {
  SESSION_MAX_AGE_SEC,
  parseSessionClaims,
  serializeSession,
  type LoginMethod,
  type SessionClaims,
} from './sessionToken';

// 세션 쿠키 헬퍼 (서버 컴포넌트·라우트 전용). 서명·검증은 sessionToken.ts.
//
// ── 세대(epoch)를 여기서 확인한다 ──────────────────────────────
// 토큰은 무상태 서명이라 개별 폐기가 안 된다. 그래서 사용자마다 **세대**를 두고,
// 강제 로그아웃 때 세대를 올려 낮은 세대의 토큰을 전부 무효로 만든다.
//
// 요청마다 사용자 한 줄을 읽는 비용이 붙는다. 그 값을 치르는 이유: 이것이 없으면
// **기기를 지워도 이미 살아 있는 세션은 안 끊긴다.** 잃어버린 기기를 지운 사람에게
// "그래도 그 사람은 아직 들어와 있습니다"라고 말할 수는 없다.

const SESSION_COOKIE = 'rm_session';

/** 현재 요청의 로그인 사용자 id (없거나 폐기된 세대면 null) */
export async function getSessionUserId(): Promise<string | null> {
  return (await getSessionClaims())?.userId ?? null;
}

/** 사용자 id에 더해 **어떻게 들어왔는지**까지 — 관문이 이것을 본다 */
export async function getSessionClaims(): Promise<SessionClaims | null> {
  const store = await cookies();
  const claims = parseSessionClaims(store.get(SESSION_COOKIE)?.value);
  if (!claims) return null;

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { sessionEpoch: true },
  });
  // 계정이 사라졌거나(탈퇴) 세대가 올라갔으면(강제 로그아웃) 이 토큰은 죽은 것이다
  if (!user || user.sessionEpoch !== claims.epoch) return null;
  return claims;
}

export async function setSessionCookie(
  userId: string,
  claims: { method: LoginMethod; verifiedAt: number },
): Promise<void> {
  // 세대는 **부르는 쪽이 정하지 않는다** — 지금 사용자의 세대를 읽어 담는다.
  // 인자로 받게 두면 언젠가 옛 세대가 그대로 실려 강제 로그아웃이 무력해진다
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { sessionEpoch: true },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, serializeSession(userId, { ...claims, epoch: user.sessionEpoch }), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
    secure: process.env.NODE_ENV === 'production',
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
