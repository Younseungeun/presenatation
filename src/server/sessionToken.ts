import { createHmac, timingSafeEqual } from 'node:crypto';

// 세션 토큰 서명·검증 (순수 — next/headers 의존 없음).
// userId + 만료를 HMAC 서명해 쿠키에 담고, 변조는 서명 검증으로 차단한다.

const AUTH_SECRET = process.env.AUTH_SECRET ?? 'dev-auth-secret-change-me';
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

function sign(payload: string): string {
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
}
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export function serializeSession(userId: string, now = Date.now()): string {
  const payload = `${b64u(userId)}.${now + SESSION_MAX_AGE_SEC * 1000}`;
  return `${payload}.${sign(payload)}`;
}

export function parseSession(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const [rawId, expStr] = payload.split('.');
  if (!rawId || !expStr || Number(expStr) < now) return null;
  return unb64u(rawId);
}
