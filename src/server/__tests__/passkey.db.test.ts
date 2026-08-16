import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  CHALLENGE_TTL_MS,
  listPasskeys,
  MAX_PASSKEYS_PER_USER,
  PasskeyError,
  purgeExpiredChallenges,
  removePasskey,
  startPasskeyLogin,
  startPasskeyRegistration,
} from '../passkeyService';

// 패스키(생체) 로그인 — **서명 검증은 라이브러리가 하고, 여기는 그 둘레를 지킨다.**
//
// 서명 검증 자체(@simplewebauthn/server)는 다시 시험하지 않는다. 우리가 틀릴 수 있는
// 곳은 그 둘레다:
//   ① 챌린지가 **한 번만** 쓰이는가 — 재사용되면 가로챈 서명 하나로 계속 로그인한다
//   ② 로그인 시작이 **누가 가입했는지 흘리지 않는가**
//   ③ 남의 기기를 지우거나 남의 계정에 심을 수 없는가
//   ④ 기기 수 상한이 실제로 걸리는가

let prisma: PrismaClient;
let userA: string;
let userB: string;
const NOW = new Date('2026-08-16T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('passkey-');
  const a = await prisma.user.create({
    data: { email: 'a@pk.io', penName: '가', identityVerified: true, identityHash: 'h-a' },
  });
  const b = await prisma.user.create({
    data: { email: 'b@pk.io', penName: '나', identityVerified: true, identityHash: 'h-b' },
  });
  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 라이브러리를 거치지 않고 열쇠를 심는다 — 둘레만 시험하므로 서명은 필요 없다 */
async function seedPasskey(userId: string, credentialId: string, label = '테스트 기기') {
  return prisma.passkey.create({
    data: { userId, credentialId, publicKey: 'pk', counter: 0, label, createdAt: NOW },
  });
}

describe('챌린지 — 한 번만 쓰인다', () => {
  it('로그인 시작이 챌린지를 남긴다', async () => {
    const before = await prisma.webAuthnChallenge.count();
    await startPasskeyLogin(prisma, NOW);
    expect(await prisma.webAuthnChallenge.count()).toBe(before + 1);
  });

  it('**로그인 시작은 누가 가입했는지 묻지도 알려주지도 않는다**', async () => {
    const options = await startPasskeyLogin(prisma, NOW);
    // allowCredentials를 비워 두면 기기가 자기 열쇠 중에서 고른다. 채워 보내면
    // "이 사람이 이 서비스에 있다"가 응답만으로 드러난다
    expect(options.allowCredentials ?? []).toEqual([]);
    // 챌린지도 아직 주인이 없다 — 서명을 받아야 누구인지 알게 된다
    const row = await prisma.webAuthnChallenge.findUniqueOrThrow({
      where: { challenge: options.challenge },
    });
    expect(row.userId).toBeNull();
    expect(row.purpose).toBe('LOGIN');
  });

  it('등록 챌린지는 그 사용자에게 묶인다 — 남의 챌린지로 내 계정에 열쇠를 못 심는다', async () => {
    const options = await startPasskeyRegistration(prisma, userA, NOW);
    const row = await prisma.webAuthnChallenge.findUniqueOrThrow({
      where: { challenge: options.challenge },
    });
    expect(row.userId).toBe(userA);
    expect(row.purpose).toBe('REGISTER');
  });

  it('시간이 지난 챌린지는 청소된다', async () => {
    await startPasskeyLogin(prisma, NOW);
    const later = new Date(NOW.getTime() + CHALLENGE_TTL_MS + 1000);
    expect(await purgeExpiredChallenges(prisma, later)).toBeGreaterThan(0);
    expect(await prisma.webAuthnChallenge.count({ where: { expiresAt: { lt: later } } })).toBe(0);
  });
});

describe('기기 등록 — 사용자 격리', () => {
  it('등록 옵션에 **이미 가진 기기**가 제외 목록으로 실린다', async () => {
    await seedPasskey(userA, 'cred-a-1');
    const options = await startPasskeyRegistration(prisma, userA, NOW);
    expect(options.excludeCredentials?.map((c) => c.id)).toContain('cred-a-1');
  });

  it('제외 목록에 **남의 기기는 실리지 않는다**', async () => {
    await seedPasskey(userB, 'cred-b-1');
    const options = await startPasskeyRegistration(prisma, userA, NOW);
    expect(options.excludeCredentials?.map((c) => c.id)).not.toContain('cred-b-1');
  });

  it('기기 수 상한이 걸린다 — 그 위는 탈취자가 하나 더 심어 두는 자리다', async () => {
    for (let i = 0; i < MAX_PASSKEYS_PER_USER; i++) {
      await prisma.passkey.upsert({
        where: { credentialId: `cap-${i}` },
        create: { userId: userA, credentialId: `cap-${i}`, publicKey: 'pk', counter: 0, label: `기기${i}` },
        update: {},
      });
    }
    await expect(startPasskeyRegistration(prisma, userA, NOW)).rejects.toThrow(PasskeyError);
  });
});

describe('기기 삭제', () => {
  it('**남의 기기는 못 지운다**', async () => {
    const mine = await seedPasskey(userB, 'cred-b-2', '나의 기기');
    await expect(removePasskey(prisma, { userId: userA, passkeyId: mine.id })).rejects.toThrow(
      PasskeyError,
    );
    expect(await prisma.passkey.findUnique({ where: { id: mine.id } })).not.toBeNull();
  });

  it('내 기기는 지워지고, 마지막 한 대도 지울 수 있다', async () => {
    await prisma.passkey.deleteMany({ where: { userId: userB } });
    const only = await seedPasskey(userB, 'cred-b-last', '유일한 기기');
    await removePasskey(prisma, { userId: userB, passkeyId: only.id });
    // 전부 지워도 잠기지 않는다 — 본인 인증으로 다시 들어온다
    expect(await listPasskeys(prisma, userB)).toEqual([]);
  });
});

describe('저장하는 것', () => {
  it('**생체 정보는 저장되지 않는다** — 공개키뿐이라 이 표가 새어도 로그인은 못 한다', async () => {
    const row = await prisma.passkey.findFirstOrThrow({ where: { userId: userA } });
    expect(Object.keys(row).sort()).toEqual(
      ['counter', 'createdAt', 'credentialId', 'id', 'label', 'lastUsedAt', 'publicKey', 'userId'].sort(),
    );
    // 비밀키를 담을 칸 자체가 없다 — 있으면 언젠가 누가 채운다
    expect(row).not.toHaveProperty('privateKey');
  });
});
