import { cookies } from 'next/headers';
import { SESSION_MAX_AGE_SEC, parseSession, serializeSession } from './sessionToken';

// 세션 쿠키 헬퍼 (서버 컴포넌트·라우트 전용). 서명·검증은 sessionToken.ts.

const SESSION_COOKIE = 'rm_session';

/** 현재 요청의 로그인 사용자 id (없으면 null) */
export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  return parseSession(store.get(SESSION_COOKIE)?.value);
}

export async function setSessionCookie(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, serializeSession(userId), {
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
