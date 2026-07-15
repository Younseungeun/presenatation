import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureResearcherProfile, hashCi, verifyAndSignIn } from '../authService';
import { StubIdentityProvider } from '../identityProvider';

let prisma: PrismaClient;
const provider = new StubIdentityProvider();

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'auth-'));
  const url = `file:${path.join(dir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  prisma = new PrismaClient({ datasourceUrl: url });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('verifyAndSignIn — 1인 1계정 강제', () => {
  it('신규 인증 시 계정 생성 (identityVerified + CI 해시 저장, 원문 미저장)', async () => {
    const r = await verifyAndSignIn(prisma, provider, {
      name: '홍길동',
      phone: '010-1234-5678',
      penName: '길동리서처',
    });
    expect(r.isNewUser).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(user.identityVerified).toBe(true);
    expect(user.penName).toBe('길동리서처');
    expect(user.identityHash).not.toBeNull();
    // CI 원문이 아니라 해시가 저장된다
    const ci = (await provider.verify({ name: '홍길동', phone: '01012345678' })).ci;
    expect(user.identityHash).toBe(hashCi(ci));
    expect(user.identityHash).not.toBe(ci);
  });

  it('같은 사람(같은 번호)이 재인증하면 같은 계정으로 로그인 — 재등록 세탁 차단', async () => {
    const again = await verifyAndSignIn(prisma, provider, {
      name: '홍길동',
      phone: '01012345678', // 하이픈만 다름 → 정규화 후 동일
      penName: '다른필명시도',
    });
    expect(again.isNewUser).toBe(false);

    // 계정이 늘어나지 않고, 필명도 최초 값 유지
    const count = await prisma.user.count();
    expect(count).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: again.userId } });
    expect(user.penName).toBe('길동리서처');
  });

  it('다른 사람은 다른 계정', async () => {
    const other = await verifyAndSignIn(prisma, provider, {
      name: '김철수',
      phone: '010-9999-8888',
    });
    expect(other.isNewUser).toBe(true);
    expect(await prisma.user.count()).toBe(2);
  });

  it('유효하지 않은 번호는 인증 실패', async () => {
    await expect(
      verifyAndSignIn(prisma, provider, { name: '홍길동', phone: '123' }),
    ).rejects.toThrow(/휴대폰/);
  });
});

describe('ensureResearcherProfile', () => {
  it('본인 인증된 사용자를 리서처로 전환 (멱등)', async () => {
    const signIn = await verifyAndSignIn(prisma, provider, {
      name: '이영희',
      phone: '010-5555-4444',
    });
    const p1 = await ensureResearcherProfile(prisma, signIn.userId);
    const p2 = await ensureResearcherProfile(prisma, signIn.userId);
    expect(p1.id).toBe(p2.id);
    expect(p1.tier).toBe('BRONZE');
  });
});
