import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  grantOperatorRole,
  OperatorGrantError,
  revokeOperatorRole,
} from '../operatorGrantService';

// 콜드 계정 회수는 수칙이 아니라 코드가 한다 (검토 4차 Q2).
//
// 콜드 계정은 1인 운영의 교착(2인 승인인데 승인자가 없다)을 푸는 금고 속 두 번째
// 계정이다 — 실제로는 "2인"이 아니라 **한 사람 + 두 번째 기기**다. 그래서 진짜 두 번째
// 운영자가 생기는 순간 반드시 사라져야 한다: 남으면 한 사람이 콜드를 쥐고 다시
// 단독 승인 능력을 갖는다. 이 파일이 지키는 성질:
//   ① 두 번째 진짜 운영자 부여와 콜드 강등은 **한 트랜잭션**이다 — 공존하는 순간이 없다
//   ② 강등은 세션까지 끊는다 — 권한만 내리면 열려 있는 운영자 세션이 그대로다
//   ③ 진짜 2명 체제에서는 콜드를 새로 만들 수 없다 — 단독 승인 백도어가 된다

let prisma: PrismaClient;
const NOW = new Date('2026-08-16T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('op-grant-');
  for (const email of ['founder@iv.io', 'cold@iv.io', 'second@iv.io', 'third@iv.io']) {
    await prisma.user.create({ data: { email, identityVerified: email !== 'cold@iv.io' } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('1인 운영 기간 — 콜드 계정으로 교착을 푼다', () => {
  it('패스키 없는 콜드는 거절된다 — CI가 없는 계정이라 기기 결속이 유일한 신원 축이다 (검토 5차 Q2)', async () => {
    await grantOperatorRole(prisma, { email: 'founder@iv.io', actor: 'cli' }, NOW);
    await expect(
      grantOperatorRole(prisma, { email: 'cold@iv.io', cold: true, actor: 'cli' }, NOW),
    ).rejects.toThrow(/패스키가 먼저/);
  });

  it('금고 기기의 패스키를 등록하면 콜드 계정이 부여된다 (본인 인증은 없어도 된다 — CI는 창업자 계정에 있다)', async () => {
    const cold0 = await prisma.user.findUniqueOrThrow({ where: { email: 'cold@iv.io' } });
    await prisma.passkey.create({
      data: { userId: cold0.id, credentialId: 'vault-cred', publicKey: 'pk', label: '금고 태블릿' },
    });
    const r = await grantOperatorRole(prisma, { email: 'cold@iv.io', cold: true, actor: 'cli' }, NOW);
    expect(r.demotedColdAccounts).toEqual([]);

    const cold = await prisma.user.findUniqueOrThrow({ where: { email: 'cold@iv.io' } });
    expect(cold.role).toBe('OPERATOR');
    expect(cold.operatorCold).toBe(true);
  });
});

describe('진짜 두 번째 운영자가 오는 순간', () => {
  it('부여와 콜드 강등이 한 번에 일어나고, 콜드의 살아 있는 세션도 끊긴다', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email: 'cold@iv.io' } });

    const r = await grantOperatorRole(prisma, { email: 'second@iv.io', actor: 'cli' }, NOW);
    expect(r.demotedColdAccounts).toEqual(['cold@iv.io']);

    const cold = await prisma.user.findUniqueOrThrow({ where: { email: 'cold@iv.io' } });
    expect(cold.role).toBe('USER');
    // epoch가 올라 이미 발급된 콜드 세션 토큰이 전부 무효다 — 강등이 즉시 사실이 된다
    expect(cold.sessionEpoch).toBe(before.sessionEpoch + 1);

    // 강등도 감사에 남는다 — "그 계정이 언제 왜 사라졌나"는 반드시 답해야 하는 질문이다
    const trail = await prisma.auditLog.findMany({
      where: { targetId: cold.id, action: 'ROLE_CHANGED' },
    });
    expect(trail.length).toBeGreaterThan(0);
  });

  it('진짜 2명 체제에서 콜드를 새로 만들 수 없다', async () => {
    await expect(
      grantOperatorRole(prisma, { email: 'third@iv.io', cold: true, actor: 'cli' }, NOW),
    ).rejects.toThrow(OperatorGrantError);
  });
});

describe('회수', () => {
  it('회수는 역할과 세션을 함께 끊는다', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email: 'second@iv.io' } });
    await revokeOperatorRole(prisma, { email: 'second@iv.io', actor: 'cli' }, NOW);
    const after = await prisma.user.findUniqueOrThrow({ where: { email: 'second@iv.io' } });
    expect(after.role).toBe('USER');
    expect(after.sessionEpoch).toBe(before.sessionEpoch + 1);
  });
});
