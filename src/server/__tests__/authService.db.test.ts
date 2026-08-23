import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  ensureResearcherProfile,
  hashCi,
  signUpAndSignIn,
  verifyAndSignIn,
} from '../authService';
import { StubIdentityProvider } from '../identityProvider';

let prisma: PrismaClient;
const provider = new StubIdentityProvider();

beforeAll(() => {
  prisma = createTestDb('auth-');
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
      penName: '철수리서처',
    });
    expect(other.isNewUser).toBe(true);
    expect(await prisma.user.count()).toBe(2);
  });

  it('유효하지 않은 번호는 인증 실패', async () => {
    await expect(
      verifyAndSignIn(prisma, provider, { name: '홍길동', phone: '123', penName: '길동' }),
    ).rejects.toThrow(/휴대폰/);
  });
});

describe('ensureResearcherProfile', () => {
  it('본인 인증된 사용자를 리서처로 전환 (멱등)', async () => {
    const signIn = await verifyAndSignIn(prisma, provider, {
      name: '이영희',
      phone: '010-5555-4444',
      penName: '영희리서처',
    });
    const p1 = await ensureResearcherProfile(prisma, signIn.userId);
    const p2 = await ensureResearcherProfile(prisma, signIn.userId);
    expect(p1.id).toBe(p2.id);
    expect(p1.tier).toBe('BRONZE');
  });
});

describe('signUpAndSignIn — 가입 갈래 (단순 이용자 / 리서처)', () => {
  it('USER로 시작하면 리서처 프로필이 생기지 않는다 (팔로우 대상도 아니다)', async () => {
    const r = await signUpAndSignIn(prisma, provider, {
      name: '이용자',
      phone: '010-1000-0001',
      penName: '그냥이용자',
      accountType: 'USER',
    });
    expect(r.researcherId).toBeNull();
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: r.userId },
      include: { researcherProfile: true },
    });
    expect(user.researcherProfile).toBeNull();
    // 필수 약관만 동의 기록 — 리서처 이용계약은 받지 않는다
    const docs = await prisma.consent.findMany({ where: { userId: r.userId } });
    expect(docs.map((c) => c.docKey).sort()).toEqual(['PRIVACY_POLICY', 'TERMS_OF_SERVICE']);
  });

  it('RESEARCHER로 시작하면 계정 생성과 동시에 프로필 + 리서처 이용계약 동의까지', async () => {
    const r = await signUpAndSignIn(prisma, provider, {
      name: '리서처',
      phone: '010-1000-0002',
      penName: '리서처하나',
      accountType: 'RESEARCHER',
    });
    expect(r.researcherId).not.toBeNull();
    const profile = await prisma.researcherProfile.findUniqueOrThrow({
      where: { id: r.researcherId! },
    });
    expect(profile.userId).toBe(r.userId);
    expect(profile.tier).toBe('BRONZE'); // 무표기에서 시작

    const docs = await prisma.consent.findMany({ where: { userId: r.userId } });
    expect(docs.map((c) => c.docKey).sort()).toEqual([
      'PRIVACY_POLICY',
      'RESEARCHER_AGREEMENT',
      'TERMS_OF_SERVICE',
    ]);
  });

  it('이미 리서처인 계정이 다시 리서처로 들어와도 프로필은 하나 (멱등)', async () => {
    const again = await signUpAndSignIn(prisma, provider, {
      name: '리서처',
      phone: '01010000002',
      penName: '리서처하나',
      accountType: 'RESEARCHER',
    });
    expect(again.isNewUser).toBe(false);
    expect(await prisma.researcherProfile.count({ where: { userId: again.userId } })).toBe(1);
  });

  it('USER로 시작한 계정도 나중에 리서처로 전환할 수 있다 (되돌릴 수 없는 선택이 아니다)', async () => {
    const first = await signUpAndSignIn(prisma, provider, {
      name: '전환자',
      phone: '010-1000-0003',
      penName: '전환하는사람',
      accountType: 'USER',
    });
    expect(first.researcherId).toBeNull();
    const profile = await ensureResearcherProfile(prisma, first.userId);
    expect(profile.userId).toBe(first.userId);
  });
});

// ── 관리자는 계정이 아니라 신원이다 (2026-08-17 사용자 확정 구조) ──────────
//
// 창업자의 CI 해시를 환경 변수(FOUNDER_CI_HASH)에 고정하면, 그 사람의 본인 인증이
// 곧 관리자 승격이다. DB를 초기화하거나 앱을 다시 깔아도 풀 로그인 한 번이면 돌아온다.
describe('창업자 신원 자동 승격', () => {
  const FOUNDER = { name: '창업자', phone: '010-7777-0001', penName: '창업자' };

  afterAll(() => {
    delete process.env.FOUNDER_CI_HASH;
  });

  it('환경 변수가 비어 있으면 아무도 승격되지 않는다', async () => {
    delete process.env.FOUNDER_CI_HASH;
    const r = await verifyAndSignIn(prisma, provider, FOUNDER);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(u.role).toBe('USER');
  });

  it('신원이 일치하는 풀 로그인은 기존 계정도 승격시킨다', async () => {
    const ci = (await provider.verify(FOUNDER)).ci;
    process.env.FOUNDER_CI_HASH = hashCi(ci);

    const r = await verifyAndSignIn(prisma, provider, FOUNDER);
    expect(r.isNewUser).toBe(false); // 위 시험에서 만든 그 계정이다
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(u.role).toBe('OPERATOR');
  });

  it('다른 사람의 인증은 승격되지 않는다 — 해시가 다르면 그냥 이용자다', async () => {
    const r = await verifyAndSignIn(prisma, provider, {
      name: '남남',
      phone: '010-7777-0002',
      penName: '남남',
    });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(u.role).toBe('USER');
  });

  it('DB가 사라져도 신원만 있으면 첫 가입부터 관리자다', async () => {
    // 새 계정 생성 경로 — 창업자와 같은 해시를 가진 새 번호는 없으므로,
    // 환경 변수를 새 사람의 해시로 바꿔 "초기화 후 첫 가입" 상황을 흉내 낸다
    const fresh = { name: '재설치창업자', phone: '010-7777-0003', penName: '재설치창업자' };
    process.env.FOUNDER_CI_HASH = hashCi((await provider.verify(fresh)).ci);
    const r = await verifyAndSignIn(prisma, provider, fresh);
    expect(r.isNewUser).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(u.role).toBe('OPERATOR');
  });
});
