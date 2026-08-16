import { createHmac, timingSafeEqual } from 'node:crypto';

// 세션 토큰 서명·검증 (순수 — next/headers 의존 없음).
// 변조는 HMAC 서명으로 차단한다.
//
// ── 세션은 "누구인가"만 담지 않는다 (2026-08-16, 인증 축 검토 A·B) ─────
// **어떻게 들어왔는지**와 **본인 인증을 언제 통과했는지**를 함께 담는다. 그 둘이
// 없으면 두 가지를 못 한다:
//
//   ① 최근성 요구 — 패스키 등록은 "방금 본인 인증한 세션"만 허용해야 한다.
//      없으면 **임시 접근이 영구 접근으로 승격된다**: 감염된 PC에서 한 번 세션이 새면
//      악성코드를 지운 뒤에도 심어 둔 열쇠는 남는다.
//      (⚠ 크기를 정확히: 이것으로 **돈은 못 가져간다** — 계좌 변경은 본인 인증과
//       은행 예금주 대조가 따로 막는다. 좁은 경로이고, 값싸게 막을 수 있어서 막는다)
//   ② 경로별 권한 — 패스키가 있는 계정에 **본인 인증으로** 들어온 세션은 위험하다.
//      유심을 가로챈 공격자가 고르는 경로가 그쪽이기 때문이다. 이쪽이 ①보다 넓다
//
// 서버에 세션 표를 두지 않고 토큰에 담는 이유: 이 값들은 **로그인 순간에 확정되고
// 그 뒤로 바뀌지 않는다.** 바뀌지 않는 사실은 서명해서 들려 보내면 되고, 그러면
// 매 요청마다 세션 조회가 붙지 않는다. (바뀌는 것 — 계좌·기기 목록 — 은 DB가 답한다)

const AUTH_SECRET = process.env.AUTH_SECRET ?? 'dev-auth-secret-change-me';
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

/** 어떤 길로 들어왔나 — IDENTITY(풀)·PASSKEY(생체)·PIN(간편 비밀번호) */
export const LOGIN_METHODS = ['IDENTITY', 'PASSKEY', 'PIN'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export interface SessionClaims {
  userId: string;
  /** 이 세션이 만들어진 길 */
  method: LoginMethod;
  /** 마지막으로 본인 인증을 통과한 시각(ms). 패스키 로그인은 인증을 안 하므로 0 */
  verifiedAt: number;
}

function sign(payload: string): string {
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
}
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export function serializeSession(
  userId: string,
  claims: { method: LoginMethod; verifiedAt: number },
  now = Date.now(),
): string {
  const payload = [
    b64u(userId),
    now + SESSION_MAX_AGE_SEC * 1000,
    claims.method,
    claims.verifiedAt,
  ].join('.');
  return `${payload}.${sign(payload)}`;
}

/**
 * 토큰을 풀어 claims를 돌려준다. 서명이 틀리거나 만료면 null.
 *
 * **옛 형식(userId + 만료만)은 "본인 인증한 적 없음"으로 읽는다.** 안전한 쪽으로
 * 틀리는 선택이다 — 그런 세션은 패스키 등록 관문에서 재인증을 요구받고, 로그인 자체는
 * 계속 유지된다. 반대로 "방금 인증했다"고 읽으면 배포 순간에 있던 모든 세션이
 * 관문을 그냥 통과한다.
 */
export function parseSessionClaims(
  token: string | undefined,
  now = Date.now(),
): SessionClaims | null {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const parts = payload.split('.');
  const [rawId, expStr, methodStr, verifiedStr] = parts;
  if (!rawId || !expStr || Number(expStr) < now) return null;

  const method: LoginMethod =
    methodStr === 'PASSKEY' || methodStr === 'PIN' || methodStr === 'IDENTITY'
      ? methodStr
      : 'IDENTITY';
  const verifiedAt = Number(verifiedStr);
  return {
    userId: unb64u(rawId),
    method,
    verifiedAt: Number.isFinite(verifiedAt) ? verifiedAt : 0,
  };
}

/** userId만 필요한 자리 (대부분의 화면) */
export function parseSession(token: string | undefined, now = Date.now()): string | null {
  return parseSessionClaims(token, now)?.userId ?? null;
}
