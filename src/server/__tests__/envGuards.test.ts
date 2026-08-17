import { describe, expect, it } from 'vitest';
import { hashCi } from '../authService';
import { assertProductionSecrets } from '../envBootCheck';
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

// 2026-08-18 배선 점검 1차: 호출 시점 검사는 서버가 뜬 뒤 **첫 손님에서** 죽는다.
// instrumentation.ts가 기동 때 이 함수를 불러 부팅 순간에 죽게 한다(fast fail).
// 검사 내용은 각 게터 그 자체라 여기와 런타임이 다른 답을 낼 수 없다 —
// 이 시험이 지키는 것은 **목록의 완전성**(필수 비밀 넷이 전부 검사에 들어 있는가)이다.
describe('부팅 검사 — 필수 비밀 넷을 한 자리에서', () => {
  it('운영 모드 + 비밀 없음 → 넷 전부를 한 번에 보고한다', () => {
    const bare = { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
    for (const name of [
      'AUTH_SECRET',
      'IDENTITY_PEPPER',
      'PAYOUT_ENC_KEY',
      'NEXT_PUBLIC_APP_ORIGIN',
    ]) {
      expect(() => assertProductionSecrets(bare)).toThrow(new RegExp(name));
    }
  });

  it('전부 있으면 통과한다', () => {
    const full = {
      NODE_ENV: 'production',
      AUTH_SECRET: 's',
      IDENTITY_PEPPER: 'p',
      PAYOUT_ENC_KEY: 'a'.repeat(64),
      NEXT_PUBLIC_APP_ORIGIN: 'https://intovill.example',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => assertProductionSecrets(full)).not.toThrow();
  });

  it('개발 모드는 폴백으로 통과한다 — 빌드·로컬을 막지 않는다', () => {
    const dev = { NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv;
    expect(() => assertProductionSecrets(dev)).not.toThrow();
  });
});
