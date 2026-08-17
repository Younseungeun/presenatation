import { createPrivateKey, sign as edSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_TOKEN_MAX_TTL_MS,
  generateRecoveryKeyPair,
  parseRecoveryGrant,
  serializeRecoveryGrant,
  signRecoveryToken,
  verifyRecoveryToken,
} from '../recoveryToken';

// 종이 열쇠 (2026-08-17 검토 7차 Q1) — **서버에 공개키만 두는 복구 수단.**
//
// 이 파일이 지키는 성질:
//   ① 금고의 종이로 찍은 표만 통과한다 (다른 열쇠·위조 서명은 안 된다)
//   ② 내용을 한 글자라도 바꾸면 통과하지 못한다 (전부가 서명 대상이다)
//   ③ **서명이 맞아도 유효 기간 상한을 넘기면 거절한다** — 서명 도구가 오염돼
//      영구 열쇠를 찍어도 서버가 안 받는다. 이 시험이 없으면 "서명만 맞으면 통과"로
//      되돌아가도 아무도 모른다
//   ④ 인가 쿠키는 서버 비밀 없이는 못 만든다

const NOW = Date.UTC(2026, 7, 17);

describe('종이 열쇠로 찍은 표', () => {
  it('① 같은 쌍의 열쇠로 찍은 표만 통과한다', () => {
    const a = generateRecoveryKeyPair();
    const b = generateRecoveryKeyPair();
    const token = signRecoveryToken(a.paperKey, { email: 'founder@iv.io' }, NOW);

    expect(verifyRecoveryToken(token, a.publicKey, NOW).email).toBe('founder@iv.io');
    // 다른 금고의 종이로 찍은 표는 남의 표다
    expect(() => verifyRecoveryToken(token, b.publicKey, NOW)).toThrow();
  });

  it('② 내용을 바꾸면 서명이 깨진다 — 대상 계정도 서명 안에 있다', () => {
    const { paperKey, publicKey } = generateRecoveryKeyPair();
    const token = signRecoveryToken(paperKey, { email: 'founder@iv.io' }, NOW);
    const parts = token.split('.');
    // 이메일 칸만 남의 것으로 바꿔치기
    parts[1] = Buffer.from('thief@iv.io', 'utf8').toString('base64url');
    expect(() => verifyRecoveryToken(parts.join('.'), publicKey, NOW)).toThrow();
  });

  it('기간이 지난 표는 안 통과한다', () => {
    const { paperKey, publicKey } = generateRecoveryKeyPair();
    const token = signRecoveryToken(paperKey, { email: 'founder@iv.io' }, NOW);
    expect(() =>
      verifyRecoveryToken(token, publicKey, NOW + RECOVERY_TOKEN_MAX_TTL_MS + 1),
    ).toThrow();
  });

  // **③ 이 시험이 이 파일의 핵심이다.**
  // 서명 스크립트가 오염되면 "100년짜리 표"를 찍을 수 있다. 그런 표가 통과하면
  // 종이 금고는 사라지고 영구 백도어 하나가 남는다 — 검증하는 쪽이 상한을 강제한다
  it('③ 서명이 맞아도 유효 기간 상한을 넘긴 표는 거절한다', () => {
    const { paperKey, publicKey } = generateRecoveryKeyPair();
    const [d, x] = paperKey.split('.');
    const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d, x }, format: 'jwk' });

    const forge = (issuedAt: number, expiresAt: number) => {
      const payload = [
        'IVREC1',
        Buffer.from('founder@iv.io', 'utf8').toString('base64url'),
        issuedAt,
        expiresAt,
        'nonce-forged',
      ].join('.');
      const sig = edSign(null, Buffer.from(payload, 'utf8'), key).toString('base64url');
      return `${payload}.${sig}`;
    };

    // 진짜 개인키로 서명했다 — 그래도 100년짜리는 안 받는다
    expect(() =>
      verifyRecoveryToken(forge(NOW, NOW + 100 * 365 * 86_400_000), publicKey, NOW),
    ).toThrow();
    // 발급 시각을 미래로 밀어 상한 검사를 우회하는 길도 막혀 있다
    expect(() =>
      verifyRecoveryToken(forge(NOW + 86_400_000, NOW + 86_400_000 + 60_000), publicKey, NOW),
    ).toThrow();
    // 상한 안이면 같은 방식으로 찍어도 통과한다 (거절 사유가 기간이지 형식이 아님을 못박는다)
    expect(verifyRecoveryToken(forge(NOW, NOW + 60_000), publicKey, NOW).nonce).toBe('nonce-forged');
  });

  it('형식이 아닌 문자열은 조용히 던진다 — 예외로 서버가 죽지 않는다', () => {
    const { publicKey } = generateRecoveryKeyPair();
    for (const junk of ['', 'hello', 'IVREC1.a.b.c', 'A.B.C.D.E.F']) {
      expect(() => verifyRecoveryToken(junk, publicKey, NOW)).toThrow();
    }
  });
});

describe('④ 복구 인가 쿠키', () => {
  it('서버가 발급한 것만 읽히고, 만료되면 안 읽힌다', () => {
    const grant = serializeRecoveryGrant('u_1', NOW);
    expect(parseRecoveryGrant(grant, NOW)).toBe('u_1');
    expect(parseRecoveryGrant(grant, NOW + 11 * 60_000)).toBeNull();
  });

  it('서명 없이 지어낸 값은 안 읽힌다', () => {
    const forged = `${Buffer.from('u_1', 'utf8').toString('base64url')}.${NOW + 600_000}.sig`;
    expect(parseRecoveryGrant(forged, NOW)).toBeNull();
    // 다른 사용자로 바꿔치기해도 서명이 안 맞는다
    const real = serializeRecoveryGrant('u_1', NOW);
    const swapped = real.replace(
      Buffer.from('u_1', 'utf8').toString('base64url'),
      Buffer.from('u_2', 'utf8').toString('base64url'),
    );
    expect(parseRecoveryGrant(swapped, NOW)).toBeNull();
  });
});
