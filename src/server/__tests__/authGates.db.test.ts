import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  assertNotElevatedRisk,
  assertRecentlyVerified,
  AuthGateError,
  ELEVATED_RISK_HOLD_MS,
  notifyElevatedRiskLogin,
  STEP_UP_WINDOW_MS,
} from '../authGates';
import type { SessionClaims } from '../sessionToken';

// **경로의 차이를 권한의 차이로 바꾼다** — 이 파일이 지키는 성질.
//
// 로그인하는 길이 둘(본인 인증 / 패스키)이 되면 도둑은 쉬운 쪽을 고른다. 유심을
// 가로챈 공격자는 패스키가 있든 없든 본인 인증으로 들어온다. 그래서 계정 진입의
// 강도는 오르지 않았고, 오른 것은 편의다.
//
// 강도를 실제로 올리는 방법은 **들어오게는 하되 열쇠를 못 심게 하는 것**이다.
// 이 파일은 그 관문 둘이 정말로 걸리는지, 그리고 **엉뚱한 사람까지 막지는 않는지**를
// 함께 고정한다 — 관문은 세게 거는 것보다 정확히 거는 것이 어렵다.

let prisma: PrismaClient;
let withKeys: string;
let noKeys: string;
const NOW = new Date('2026-08-16T00:00:00Z');

const claims = (userId: string, over: Partial<SessionClaims> = {}): SessionClaims => ({
  userId,
  method: 'IDENTITY',
  verifiedAt: NOW.getTime(),
  ...over,
});

beforeAll(async () => {
  prisma = createTestDb('auth-gates-');
  const a = await prisma.user.create({
    data: { email: 'keys@g.io', identityVerified: true, identityHash: 'g-a' },
  });
  const b = await prisma.user.create({
    data: { email: 'nokeys@g.io', identityVerified: true, identityHash: 'g-b' },
  });
  withKeys = a.id;
  noKeys = b.id;
  await prisma.passkey.create({
    data: { userId: withKeys, credentialId: 'g-cred', publicKey: 'pk', counter: 0, label: '내 폰' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('① 최근성 — 기기 등록은 방금 인증한 세션만', () => {
  it('방금 인증했으면 통과한다', () => {
    expect(() => assertRecentlyVerified(claims(noKeys), NOW)).not.toThrow();
  });

  it('창을 넘기면 재인증을 요구한다', () => {
    const later = new Date(NOW.getTime() + STEP_UP_WINDOW_MS + 1000);
    try {
      assertRecentlyVerified(claims(noKeys), later);
      throw new Error('막았어야 한다');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthGateError);
      // 코드가 있어야 화면이 "재인증하면 지금 풀린다"와 "기다려야 한다"를 나눈다
      expect((e as AuthGateError).code).toBe('REVERIFY_REQUIRED');
    }
  });

  it('**패스키로 들어온 세션은 언제나 막힌다** — 열쇠로 열쇠를 심지 못한다', () => {
    // verifiedAt이 0이라 창을 벗어나 있다. 이 성질이 없으면 훔친 기기 하나가
    // 계정을 영구히 장악한다(자기 기기를 계속 심을 수 있으므로)
    const passkeySession = claims(withKeys, { method: 'PASSKEY', verifiedAt: 0 });
    expect(() => assertRecentlyVerified(passkeySession, NOW)).toThrow(AuthGateError);
  });

  it('**첫 등록도 예외가 아니다** — 규칙의 예외는 반드시 그 자리가 공격 경로가 된다', () => {
    // 패스키가 하나도 없어도(=첫 등록) 최근성은 똑같이 요구된다.
    // 가입 직후라면 방금 인증했으므로 자연히 통과한다 — 예외 없이도 매끄럽다
    const stale = new Date(NOW.getTime() + STEP_UP_WINDOW_MS + 1000);
    expect(() => assertRecentlyVerified(claims(noKeys), stale)).toThrow(AuthGateError);
  });
});

describe('② 경로 — 패스키가 있는데 본인 인증으로 들어왔다면', () => {
  it('48시간 동안 새 기기를 못 심는다', async () => {
    try {
      await assertNotElevatedRisk(prisma, claims(withKeys), NOW);
      throw new Error('막았어야 한다');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthGateError);
      expect((e as AuthGateError).code).toBe('ELEVATED_RISK_HOLD');
    }
  });

  it('48시간이 지나면 풀린다', async () => {
    const later = new Date(NOW.getTime() + ELEVATED_RISK_HOLD_MS + 1000);
    await expect(assertNotElevatedRisk(prisma, claims(withKeys), later)).resolves.toBeUndefined();
  });

  it('**패스키가 하나도 없으면 걸지 않는다** — 걸면 아무도 첫 기기를 등록하지 못한다', async () => {
    await expect(assertNotElevatedRisk(prisma, claims(noKeys), NOW)).resolves.toBeUndefined();
  });

  it('패스키로 들어온 세션에는 걸지 않는다 — 위험한 경로가 아니다', async () => {
    const viaPasskey = claims(withKeys, { method: 'PASSKEY', verifiedAt: 0 });
    await expect(assertNotElevatedRisk(prisma, viaPasskey, NOW)).resolves.toBeUndefined();
  });
});

describe('알림 — 유예만으로는 절반이다', () => {
  it('패스키가 있는 계정에 본인 인증으로 들어오면 알린다', async () => {
    expect(await notifyElevatedRiskLogin(prisma, withKeys, NOW)).toBe(true);
    const n = await prisma.notification.findFirst({
      where: { userId: withKeys, type: 'RISKY_LOGIN' },
    });
    expect(n?.body).toContain('정산을 동결');
  });

  it('패스키가 없으면 알리지 않는다 — 그 사람에겐 그것이 평소 경로다', async () => {
    expect(await notifyElevatedRiskLogin(prisma, noKeys, NOW)).toBe(false);
    expect(
      await prisma.notification.count({ where: { userId: noKeys, type: 'RISKY_LOGIN' } }),
    ).toBe(0);
  });
});
