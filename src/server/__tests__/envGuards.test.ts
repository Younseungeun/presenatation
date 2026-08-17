import { describe, expect, it } from 'vitest';
import { hashCi } from '../authService';
import { serializeRecoveryGrant } from '../recoveryToken';
import { serializeSession } from '../sessionToken';

// 비밀값의 운영 강제 (2026-08-18 전수 점검에서 발견한 구멍의 회귀 방지).
//
// PAYOUT_ENC_KEY·NEXT_PUBLIC_APP_ORIGIN은 "운영에서 값이 없으면 던진다"인데
// AUTH_SECRET·IDENTITY_PEPPER만 개발 폴백으로 **조용히** 물러서고 있었다 —
// 폴백 값은 저장소에 적혀 있어 공개나 다름없고, 그 값으로 세션을 서명하면
// 저장소를 본 누구나 세션(관리자 포함)을 위조할 수 있다.
//
// 이 시험이 지키는 성질: **운영 모드 + 비밀 없음 = 즉시 실패.**
// 조용히 도는 것이 아니라 시끄럽게 죽어야, 출시 날 잊은 것을 그 자리에서 안다.

/** NODE_ENV·비밀을 잠깐 바꿨다가 반드시 되돌린다 — 다른 시험이 같은 프로세스를 쓴다 */
function inProductionWithoutSecrets<T>(fn: () => T): T {
  // Next 타입이 NODE_ENV를 읽기 전용으로 선언한다 — 시험에서만 인덱스로 우회한다
  const env = process.env as unknown as Record<string, string | undefined>;
  const saved = {
    NODE_ENV: env.NODE_ENV,
    AUTH_SECRET: env.AUTH_SECRET,
    IDENTITY_PEPPER: env.IDENTITY_PEPPER,
  };
  try {
    env.NODE_ENV = 'production';
    delete env.AUTH_SECRET;
    delete env.IDENTITY_PEPPER;
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

describe('운영 모드에서 비밀이 없으면 던진다', () => {
  it('세션 서명 — AUTH_SECRET', () => {
    inProductionWithoutSecrets(() => {
      expect(() => serializeSession('u_1', { method: 'PIN', verifiedAt: 0, epoch: 0 })).toThrow(
        /AUTH_SECRET/,
      );
    });
  });

  it('복구 인가 쿠키 — 같은 비밀을 쓴다', () => {
    inProductionWithoutSecrets(() => {
      expect(() => serializeRecoveryGrant('u_1')).toThrow(/AUTH_SECRET/);
    });
  });

  it('신원 해시 — IDENTITY_PEPPER', () => {
    inProductionWithoutSecrets(() => {
      expect(() => hashCi('ci-x')).toThrow(/IDENTITY_PEPPER/);
    });
  });

  it('개발 모드는 폴백으로 계속 돈다 — 개발 편의는 그대로다', () => {
    expect(() => serializeSession('u_1', { method: 'PIN', verifiedAt: 0, epoch: 0 })).not.toThrow();
    expect(() => hashCi('ci-x')).not.toThrow();
  });
});
