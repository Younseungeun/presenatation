import { cookies } from 'next/headers';
import {
  RECOVERY_GRANT_TTL_MS,
  parseRecoveryGrant,
  serializeRecoveryGrant,
} from './recoveryToken';

// 복구 인가 쿠키 (서버 컴포넌트·라우트 전용). 서명·검증은 recoveryToken.ts.
//
// **세션 쿠키와 다른 이름을 쓴다.** 같은 쿠키에 실어 주면 이 인가가 어느새 로그인처럼
// 굴러다니게 되고, "패스키 등록만"이라는 경계가 코드가 아니라 관습이 된다.
// 이름이 다르면 그 경계를 읽는 쪽에서 지킬 수 있다 — 이 쿠키를 보는 곳은
// `/api/passkey/register` 단 하나다.

const RECOVERY_COOKIE = 'rm_recovery';

export async function issueRecoveryGrant(userId: string): Promise<void> {
  const store = await cookies();
  store.set(RECOVERY_COOKIE, serializeRecoveryGrant(userId), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(RECOVERY_GRANT_TTL_MS / 1000),
    secure: process.env.NODE_ENV === 'production',
  });
}

/** 지금 요청이 복구 인가를 들고 있나 — 아니면 null */
export async function readRecoveryGrant(): Promise<string | null> {
  const store = await cookies();
  return parseRecoveryGrant(store.get(RECOVERY_COOKIE)?.value);
}

export async function clearRecoveryGrant(): Promise<void> {
  const store = await cookies();
  store.delete(RECOVERY_COOKIE);
}
