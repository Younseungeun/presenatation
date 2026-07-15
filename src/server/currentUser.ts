import { cookies } from 'next/headers';

// 데모 신원: 본인 인증(세션) 구현 전까지 쿠키로 "현재 구매자"를 식별한다.
// TODO: 세션 기반 인증으로 교체 (CLAUDE.md 6.3절 7번)

export const DEMO_USER_COOKIE = 'demo-user-id';

export async function getDemoUserId(): Promise<string | null> {
  const store = await cookies();
  return store.get(DEMO_USER_COOKIE)?.value ?? null;
}
