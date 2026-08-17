import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { hashCi } from '../authService';
import { ELEVATED_RISK_HOLD_MS } from '../authGates';
import { consumeOperatorRecheck, issueOperatorRecheck } from '../operatorApprovalService';
import { redeemRecoveryToken } from '../recoveryService';
import { generateRecoveryKeyPair, signRecoveryToken } from '../recoveryToken';

// 비상 복구 사용처 (2026-08-17 검토 7차 Q1).
//
// 이 파일이 지키는 성질:
//   ① 설정이 없으면 **경로 자체가 없다** (공개키나 창업자 해시 중 하나만 있어도 꺼진다)
//   ② 대상은 창업자 계정 하나뿐이다 — 종이가 모든 사용자의 계정 복구 도구가 되면 안 된다
//   ③ 표는 1회용이다 — 같은 표로 두 번 열리면 그건 재사용 가능한 열쇠다
//   ④ 열리는 것은 패스키 등록 권한뿐이고, 그 사실이 감사 로그에 남는다

let prisma: PrismaClient;
let founderId: string;
let keys: ReturnType<typeof generateRecoveryKeyPair>;
const FOUNDER_CI = hashCi('ci-founder');
const NOW = new Date('2026-08-17T00:00:00Z');

const env = (over: { RECOVERY_PUBLIC_KEY?: string; FOUNDER_CI_HASH?: string } = {}) => ({
  RECOVERY_PUBLIC_KEY: keys.publicKey,
  FOUNDER_CI_HASH: FOUNDER_CI,
  ...over,
});

beforeAll(async () => {
  prisma = createTestDb('recovery-');
  keys = generateRecoveryKeyPair();
  founderId = (
    await prisma.user.create({
      data: {
        email: 'founder@iv.io',
        identityVerified: true,
        identityHash: FOUNDER_CI,
        role: 'OPERATOR',
      },
    })
  ).id;
  await prisma.user.create({
    data: { email: 'someone@iv.io', identityVerified: true, identityHash: hashCi('ci-other') },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const tokenFor = (email: string, at = NOW.getTime()) =>
  signRecoveryToken(keys.paperKey, { email }, at);

describe('① 설정이 없으면 이 경로는 없다', () => {
  it('공개키가 없으면 DISABLED — 라우트가 404로 바꾼다', async () => {
    await expect(
      redeemRecoveryToken(
        prisma,
        { token: tokenFor('founder@iv.io') },
        NOW,
        env({ RECOVERY_PUBLIC_KEY: undefined }),
      ),
    ).rejects.toMatchObject({ code: 'DISABLED' });
  });

  it('창업자 해시가 없어도 DISABLED — 반쯤 켜진 상태를 만들지 않는다', async () => {
    await expect(
      redeemRecoveryToken(
        prisma,
        { token: tokenFor('founder@iv.io') },
        NOW,
        env({ FOUNDER_CI_HASH: undefined }),
      ),
    ).rejects.toMatchObject({ code: 'DISABLED' });
  });
});

describe('② 종이는 창업자 계정 하나만 연다', () => {
  it('다른 사용자를 겨눈 표는 서명이 맞아도 거절한다', async () => {
    await expect(
      redeemRecoveryToken(prisma, { token: tokenFor('someone@iv.io') }, NOW, env()),
    ).rejects.toThrow(/올바르지 않거나/);
  });

  it('없는 계정도 같은 말로 거절한다 — 이 창구가 조회기가 되면 안 된다', async () => {
    await expect(
      redeemRecoveryToken(prisma, { token: tokenFor('nobody@iv.io') }, NOW, env()),
    ).rejects.toThrow(/올바르지 않거나/);
  });

  it('기간이 지난 표도 거절한다', async () => {
    await expect(
      redeemRecoveryToken(
        prisma,
        { token: tokenFor('founder@iv.io', NOW.getTime() - 20 * 60_000) },
        NOW,
        env(),
      ),
    ).rejects.toThrow();
  });
});

describe('③④ 통과 — 한 번만, 그리고 기록이 남는다', () => {
  it('창업자 계정을 열고, 감사 로그에 남고, 같은 표는 두 번 안 통한다', async () => {
    const token = tokenFor('founder@iv.io');
    const { userId } = await redeemRecoveryToken(
      prisma,
      { token, note: '공급자 장애 + 기기 분실' },
      NOW,
      env(),
    );
    expect(userId).toBe(founderId);

    // 표를 태운 흔적 — 지우지 않는다
    expect(await prisma.recoveryUse.count({ where: { targetUserId: founderId } })).toBe(1);

    // 열린 권한이 무엇인지까지 기록에 남는다 (세션이 아니라 등록 하나)
    const log = await prisma.auditLog.findFirst({
      where: { action: 'RECOVERY_GRANTED', targetId: founderId },
    });
    expect(log?.reason).toBe('공급자 장애 + 기기 분실');
    expect(log?.after).toContain('PASSKEY_REGISTER_ONLY');

    // ③ 같은 표를 다시 내밀면 막힌다
    await expect(
      redeemRecoveryToken(prisma, { token }, NOW, env()),
    ).rejects.toMatchObject({ code: 'USED' });
  });

  it('새로 서명한 표는 다시 통한다 — 막힌 것은 재사용이지 복구가 아니다', async () => {
    const { userId } = await redeemRecoveryToken(
      prisma,
      { token: tokenFor('founder@iv.io') },
      NOW,
      env(),
    );
    expect(userId).toBe(founderId);
    expect(await prisma.recoveryUse.count({ where: { targetUserId: founderId } })).toBe(2);
  });
});

// **이 묶음이 종이 열쇠를 안전하게 만드는 부분이다** (2026-08-17 자체 발견).
//
// 종이만 훔친 사람도 복구 화면에서 *자기* 지문을 등록할 수 있다. 그러면 그 뒤의 생체
// 재확인은 그의 지문으로 통과하고, 관문이 통째로 그의 것이 된다 — 백도어를 안 만들려고
// 만든 경로가 물리 백도어가 되는 것이다. 그래서 복구 직후 48시간은 돈이 안 나간다.
describe('복구 직후 48시간은 돈이 안 나간다', () => {
  it('지문·얼굴을 통과한 표를 들고 와도 유예 중에는 막힌다', async () => {
    // 앞 시험들이 이미 복구를 썼다 — recoveredAt이 NOW로 찍혀 있다
    const token = await issueOperatorRecheck(prisma, founderId, NOW);
    await expect(consumeOperatorRecheck(prisma, founderId, token, NOW)).rejects.toThrow(
      /비상 복구를 쓴 직후/,
    );
    // 표는 살아 있다 — 유예에 막힌 것이지 표가 틀린 것이 아니다
    const op = await prisma.user.findUniqueOrThrow({ where: { id: founderId } });
    expect(op.operatorRecheckTokenHash).not.toBeNull();
  });

  it('48시간이 지나면 평소대로 통과한다 — 유예지 차단이 아니다', async () => {
    const later = new Date(NOW.getTime() + ELEVATED_RISK_HOLD_MS + 1000);
    const token = await issueOperatorRecheck(prisma, founderId, later);
    await expect(consumeOperatorRecheck(prisma, founderId, token, later)).resolves.toBeUndefined();
  });

  it('복구를 쓴 적 없는 운영자는 유예와 무관하다', async () => {
    const plain = await prisma.user.create({
      data: { email: 'plain-op@iv.io', identityVerified: true, role: 'OPERATOR' },
    });
    const token = await issueOperatorRecheck(prisma, plain.id, NOW);
    await expect(consumeOperatorRecheck(prisma, plain.id, token, NOW)).resolves.toBeUndefined();
  });
});
