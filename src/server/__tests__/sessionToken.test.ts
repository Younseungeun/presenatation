import { describe, expect, it } from 'vitest';
import { parseSession, serializeSession } from '../sessionToken';

describe('session token — 서명·변조·만료', () => {
  it('서명한 토큰은 같은 userId로 복원', () => {
    const token = serializeSession('user_123');
    expect(parseSession(token)).toBe('user_123');
  });

  it('변조된 토큰은 거부 (서명 불일치)', () => {
    const token = serializeSession('user_123');
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
    const token = serializeSession('user_123', issuedAt);
    const later = issuedAt + 40 * 24 * 3600 * 1000; // 40일 후 (만료 30일)
    expect(parseSession(token, later)).toBeNull();
  });
});
