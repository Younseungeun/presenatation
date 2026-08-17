import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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

  // ── 목록 누락 래칫 (2026-08-18 배선 점검 2차) ────────────────────
  //
  // 부팅 검사의 유일한 어긋남은 "새 비밀의 게터를 만들고 목록에 안 부르는 것"이다.
  // 검토자는 ESLint로 process.env 접근을 전면 금지하자고 했지만, 이 저장소는 게터가
  // 중앙 파일이 아니라 **쓰는 모듈 옆에** 살도록 일부러 설계했고(단일 진실 공급원),
  // 폴백이 안전한 선택적 env 읽기(OPS_WEBHOOK_URL 등)가 수십 곳이라 전면 금지는
  // disable 주석 세례가 된다. 대신 constantBasis와 같은 래칫으로 잡는다:
  //
  // **"운영 환경에는 X가 반드시" 메시지 규약을 소스에서 스캔해**, 그 이름 전부가
  // 부팅 검사의 실패 보고에 들어 있기를 요구한다. 새 게터가 규약대로 메시지를 적는
  // 순간 이 시험이 부팅 목록 추가를 강제한다 — 사람 눈(PR 검토)이 아니라 시험이 잡는다.
  it('"운영이면 반드시" 비밀은 전부 부팅 검사에 들어 있다 — 목록 누락 래칫', () => {
    const names = requiredEnvNamesInSource();
    // 스캔 자체가 살아 있는지 — 지금 알고 있는 넷이 반드시 잡혀야 한다
    expect(names).toEqual(
      expect.arrayContaining([
        'AUTH_SECRET',
        'IDENTITY_PEPPER',
        'PAYOUT_ENC_KEY',
        'NEXT_PUBLIC_APP_ORIGIN',
      ]),
    );

    let report = '';
    try {
      assertProductionSecrets({ NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv);
    } catch (e) {
      report = (e as Error).message;
    }
    for (const name of names) {
      expect(report).toContain(name);
    }
  });
});

/** src 전체에서 "운영 환경에는 X가 반드시" 규약의 env 이름을 긁는다 (시험 파일 제외) */
function requiredEnvNamesInSource(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== '__fixtures__') walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/운영 환경에는 ([A-Z0-9_]+)[이가]? 반드시/g)) {
        names.add(m[1]);
      }
    }
  };
  walk(path.resolve(__dirname, '..', '..'));
  return [...names];
}
