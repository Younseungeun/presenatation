import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, timingSafeEqual, verify as edVerify } from 'node:crypto';
// 세션과 같은 서명 비밀 — 운영에서 값이 없으면 던지는 규칙도 함께 온다
import { authSecret } from './sessionToken';

// **종이 열쇠** — 인터넷에 존재하지 않는 복구 수단 (2026-08-17 검토 7차 Q1).
//
// ── 무엇을 푸는 문제인가 ──────────────────────────────────────
// 관리자 권한이 신원(CI)에 걸리고 부트스트랩 관문이 붙으면서 사슬이 이렇게 됐다:
//     관리자 화면 ← 패스키 필요 ← 등록하려면 본인 인증 직후 ← 본인 인증 공급자
// 공급자가 죽은 채로 기기까지 잃으면 **관리자가 영영 못 들어온다.** 그리고 공급자
// 장애는 다른 장애와 겹쳐 오므로, 하필 사고 대응이 가장 필요한 순간에 닫힌다.
//
// ── 왜 비상용 환경 변수 토큰이 아닌가 ─────────────────────────
// 환경 변수에 비상 암호를 두면 **그것이 상시 백도어**다 — 서버 환경 변수를 읽을 수
// 있는 자가 곧 관리자가 된다. 공급자 장애 시 관문을 자동으로 푸는 것은 더 나쁘다:
// 공격자에게 "장애를 일으키면 관문이 열린다"는 스위치를 쥐여 준다.
//
// ── 비대칭 열쇠는 그 둘과 다르다 ──────────────────────────────
// 서버에는 **공개키만** 둔다. 공개키로는 서명을 만들 수 없으므로, 서버를 통째로
// 장악해 환경 변수를 다 털어도 이 경로로는 아무것도 못 한다. 서명을 만들 수 있는
// 개인키는 **종이에 인쇄되어 금고에 있고, 어떤 기기에도 저장되지 않는다.**
// 즉 발동 조건이 "물리 금고를 연다"로 내려간다 — 그건 백도어가 아니라 물리 보안이다.
//
// ── JWT를 쓰지 않는다 ─────────────────────────────────────────
// JWT는 **알고리즘을 토큰 자신이 선언한다.** 그 한 줄이 alg=none과 "공개키를 HMAC
// 비밀키로 쓰기"라는 고전적 우회를 낳았고, 둘 다 검증을 통과시키면서 테스트는
// 초록불이다. 여기서는 형식이 Ed25519 하나로 고정이고 그 사실이 코드에 박혀 있다 —
// **선택지가 없으면 혼동도 없다.**
//
// ── 발급자도 영원한 표를 못 만든다 ────────────────────────────
// 유효 기간은 서명하는 쪽이 적지만 **검증하는 쪽이 상한을 강제한다.** 서명 스크립트가
// 오염돼 100년짜리를 찍어도 서버가 안 받는다. "서명만 맞으면 통과"는 서명 도구를
// 신뢰 기반에 올리는 것이고, 그러면 종이 금고의 의미가 절반으로 준다.

export class RecoveryError extends Error {
  constructor(
    message: string,
    /** DISABLED는 라우트가 404로 바꾼다 — 없는 기능은 없는 것처럼 보여야 한다 */
    readonly code: 'DISABLED' | 'INVALID' | 'USED' = 'INVALID',
  ) {
    super(message);
    this.name = 'RecoveryError';
  }
}

/** 토큰 형식 표시 — 형식을 바꿔야 할 날이 오면 옛 토큰이 조용히 통과하지 않게 */
const MAGIC = 'IVREC1';

/**
 * 검증 쪽이 강제하는 유효 기간 상한.
 *
 * 금고에서 종이를 꺼내 노트북에서 서명하고 브라우저에 붙여 넣기까지의 시간이다.
 * 이 값을 넘겨 서명된 표는 **서명이 맞아도** 거절된다.
 *
 * @근거 설계 금고에서 꺼내 서명하고 붙여 넣기까지 — 그 이상은 표를 들고 다니는 것이다
 */
export const RECOVERY_TOKEN_MAX_TTL_MS = 10 * 60_000;

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** 원시 32바이트 키를 Node가 아는 형태로 — JWK라 DER 매직 상수를 손으로 안 만든다 */
const publicKeyOf = (x: string) =>
  createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
const privateKeyOf = (d: string, x: string) =>
  createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d, x }, format: 'jwk' });

/**
 * 열쇠 한 쌍을 만든다 — **인터넷이 끊긴 기기에서 한 번만** (scripts/makeRecoveryKey.ts).
 *
 * `publicKey`는 서버 환경 변수(RECOVERY_PUBLIC_KEY)로 간다.
 * `paperKey`는 종이에 인쇄해 금고에 넣는다 — 파일로 저장하는 순간 이 설계가 무너진다.
 */
export function generateRecoveryKeyPair(): { publicKey: string; paperKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }) as { x: string };
  const priv = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  // 종이에는 한 줄만 — 두 줄을 옮겨 적게 하면 옮겨 적는 실수가 두 배가 된다
  return { publicKey: pub.x, paperKey: `${priv.d}.${priv.x}` };
}

/** 금고 밖 노트북에서 표를 찍는다 (scripts/signRecovery.ts) */
export function signRecoveryToken(
  paperKey: string,
  input: { email: string; ttlMs?: number },
  now = Date.now(),
): string {
  const [d, x] = paperKey.trim().split('.');
  if (!d || !x) throw new RecoveryError('종이 열쇠 형식이 아닙니다');
  const ttl = Math.min(input.ttlMs ?? RECOVERY_TOKEN_MAX_TTL_MS, RECOVERY_TOKEN_MAX_TTL_MS);
  const payload = [
    MAGIC,
    b64u(Buffer.from(input.email, 'utf8')),
    now,
    now + ttl,
    b64u(randomBytes(16)),
  ].join('.');
  const sig = edSign(null, Buffer.from(payload, 'utf8'), privateKeyOf(d, x));
  return `${payload}.${b64u(sig)}`;
}

export interface RecoveryClaims {
  email: string;
  /** 1회용 표시 — 서버가 이 값을 태워서 재사용을 막는다 */
  nonce: string;
  expiresAt: number;
}

/**
 * 표를 검증한다 — 서명·형식·기간을 전부 본다.
 *
 * **기간을 서명과 같은 무게로 본다**: 서명만 맞으면 통과시키는 구현은 서명 도구가
 * 오염되는 순간 영구 열쇠를 발급하게 된다.
 */
export function verifyRecoveryToken(
  token: string,
  publicKeyX: string,
  now = Date.now(),
): RecoveryClaims {
  const bad = () => new RecoveryError('복구 표가 올바르지 않거나 기간이 지났습니다');
  const parts = token.trim().split('.');
  if (parts.length !== 6) throw bad();
  const [magic, emailB64, issuedStr, expStr, nonce, sigB64] = parts;
  if (magic !== MAGIC) throw bad();

  const issuedAt = Number(issuedStr);
  const expiresAt = Number(expStr);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) throw bad();
  if (expiresAt <= now) throw bad();
  // 발급자가 스스로 정한 기간이라도 상한을 넘으면 안 받는다
  if (expiresAt - issuedAt > RECOVERY_TOKEN_MAX_TTL_MS) throw bad();
  // 시계가 앞선 표(미래 발급)는 상한 검사를 우회하는 길이다
  if (issuedAt > now + 60_000) throw bad();

  const payload = parts.slice(0, 5).join('.');
  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(payload, 'utf8'), publicKeyOf(publicKeyX), fromB64u(sigB64));
  } catch {
    throw bad(); // 공개키가 깨졌거나 서명 길이가 안 맞는다
  }
  if (!ok) throw bad();

  return { email: fromB64u(emailB64).toString('utf8'), nonce, expiresAt };
}

// ── 복구 인가 쿠키 ────────────────────────────────────────────
//
// 표를 통과해도 **로그인 세션은 만들지 않는다.** 이 쿠키가 허락하는 것은 딱 하나,
// **이 기기에 패스키를 등록하는 것**이다. 종이 열쇠로 관리자 세션을 열어 버리면
// 금고 속 종이가 곧 돈 열쇠가 되는데, 그러면 막으려던 것을 그대로 되살린다.
// 등록을 마치면 평소 경로(패스키 로그인)로 돌아가고, 그 뒤의 모든 돈 관문
// (생체 재확인·48시간 유예)은 하나도 면제되지 않는다.

// (인가 쿠키 서명은 세션과 같은 비밀을 쓴다 — 상단 import 참고)

/**
 * 인가의 수명 — 패스키 등록 한 번을 마치기에 넉넉한 만큼만.
 * 지문 인식이 실패해 다시 시도할 여유까지 본다.
 *
 * @근거 설계 패스키 등록 한 번 + 재시도 여유 — 표의 상한과 같은 근거
 */
export const RECOVERY_GRANT_TTL_MS = 10 * 60_000;

const grantSig = (payload: string) =>
  createHmac('sha256', authSecret()).update(payload).digest('base64url');

export function serializeRecoveryGrant(userId: string, now = Date.now()): string {
  const payload = `${b64u(Buffer.from(userId, 'utf8'))}.${now + RECOVERY_GRANT_TTL_MS}`;
  return `${payload}.${grantSig(payload)}`;
}

/** 서명이 틀리거나 기간이 지났으면 null — 부르는 쪽이 분기할 것이 없다 */
export function parseRecoveryGrant(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const a = Buffer.from(token.slice(idx + 1));
  const b = Buffer.from(grantSig(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [rawId, expStr] = payload.split('.');
  if (!rawId || !expStr || Number(expStr) < now) return null;
  return fromB64u(rawId).toString('utf8');
}
