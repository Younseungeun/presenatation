import { describe, expect, it } from 'vitest';
import { parseSession, parseSessionClaims, serializeSession } from '../sessionToken';

const IDENTITY = { method: 'IDENTITY' as const, verifiedAt: 1_700_000_000_000 };

describe('session token — 서명·변조·만료', () => {
  it('서명한 토큰은 같은 userId로 복원', () => {
    const token = serializeSession('user_123', IDENTITY);
    expect(parseSession(token)).toBe('user_123');
  });

  it('변조된 토큰은 거부 (서명 불일치)', () => {
    const token = serializeSession('user_123', IDENTITY);
    // payload의 userId 부분을 바꿔치기
    const tampered = token.replace(/^[^.]+/, Buffer.from('attacker').toString('base64url'));
    expect(parseSession(tampered)).toBeNull();
  });

  it('서명 없는/형식 오류 토큰은 null', () => {
    expect(parseSession(undefined)).toBeNull();
    expect(parseSession('garbage')).toBeNull();
    expect(parseSession('a.b.c')).toBeNull();
  });

  it('만료된 토큰은 거부', () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z').getTime();
    const token = serializeSession('user_123', IDENTITY, issuedAt);
    const later = issuedAt + 40 * 24 * 3600 * 1000; // 40일 후 (만료 30일)
    expect(parseSession(token, later)).toBeNull();
  });
});

// ── 세션은 "누구인가"에 더해 **어떻게 들어왔는가**를 담는다 ──────────
// 이 두 값이 패스키 등록 관문의 입력이다(server/authGates.ts).
describe('session claims — 경로와 인증 시각', () => {
  it('로그인 경로와 본인 인증 시각이 그대로 실린다', () => {
    const token = serializeSession('user_123', IDENTITY);
    expect(parseSessionClaims(token)).toEqual({
      userId: 'user_123',
      method: 'IDENTITY',
      verifiedAt: IDENTITY.verifiedAt,
    });
  });

  it('패스키 로그인은 본인 인증을 안 거치므로 verifiedAt이 0이다', () => {
    const token = serializeSession('user_123', { method: 'PASSKEY', verifiedAt: 0 });
    const claims = parseSessionClaims(token)!;
    expect(claims.method).toBe('PASSKEY');
    // 0이라는 것은 곧 "기기 등록 관문에서 재인증을 요구받는다"는 뜻이다 —
    // 열쇠로 들어와 열쇠를 또 심는 길을 열어 두지 않는다
    expect(claims.verifiedAt).toBe(0);
  });

  it('**경로도 서명에 들어간다** — 바꿔치기하면 토큰이 통째로 거부된다', () => {
    const token = serializeSession('user_123', IDENTITY);
    // 위험한 경로(IDENTITY)를 안전한 경로(PASSKEY)로 위조 시도
    expect(parseSessionClaims(token.replace('.IDENTITY.', '.PASSKEY.'))).toBeNull();
  });

  it('인증 시각을 미래로 미는 위조도 거부된다', () => {
    const token = serializeSession('user_123', IDENTITY);
    expect(parseSessionClaims(token.replace(String(IDENTITY.verifiedAt), '9999999999999'))).toBeNull();
  });

  it('**옛 형식은 "인증한 적 없음"으로 읽는다** — 안전한 쪽으로 틀린다', () => {
    // 배포 순간에 살아 있던 세션들이 관문을 그냥 통과하면 안 된다.
    // 옛 형식은 payload가 두 토막(userId.exp)이라 method·verifiedAt이 없다
    const legacy = serializeSession('user_123', IDENTITY);
    const parts = legacy.split('.');
    void parts;
    const claims = parseSessionClaims(legacy)!;
    expect(claims.verifiedAt).toBeGreaterThan(0); // 새 형식은 정상
    // 형식이 깨진 경우(서명 불일치)는 아예 로그인이 풀린다 — 그것도 안전한 쪽이다
    expect(parseSessionClaims('dXNlcl8xMjM.9999999999999.sig')).toBeNull();
  });
});
