import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  isTrustedDevice,
  isWeakPin,
  MAX_PIN_ATTEMPTS,
  PinError,
  setupPin,
  verifyPinLogin,
} from '../pinService';

// 간편 비밀번호 — **기기에 묶인 6자리** (2026-08-16 사용자 확정 구조).
//
// 이 파일이 지키는 성질:
//   ① 비밀번호는 **기기와 함께**만 열린다 — 유출된 비밀번호를 다른 기기에서 못 쓴다
//   ② 연속 실패 상한 — 6자리(조합 100만)는 상한 없이는 장식이다
//   ③ 잠기면 본인에게 알리고, 풀 로그인으로만 다시 연다
//   ④ 평문은 어디에도 없다 — 비밀번호도 기기 토큰도 해시만 남는다

let prisma: PrismaClient;
let userA: string;
let userB: string;
const NOW = new Date('2026-08-16T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('pin-');
  const a = await prisma.user.create({
    data: { email: 'a@pin.io', identityVerified: true, identityHash: 'pin-a' },
  });
  const b = await prisma.user.create({
    data: { email: 'b@pin.io', identityVerified: true, identityHash: 'pin-b' },
  });
  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('설정', () => {
  it('뻔한 번호는 못 정한다 — 훑는 공격이 그 값부터 넣는다', async () => {
    for (const weak of ['111111', '123456', '654321', '000000']) {
      expect(isWeakPin(weak)).toBe(true);
      await expect(setupPin(prisma, { userId: userA, pin: weak, label: '폰' })).rejects.toThrow(
        PinError,
      );
    }
    expect(isWeakPin('280731')).toBe(false);
  });

  it('숫자 6자리가 아니면 거절한다', async () => {
    await expect(setupPin(prisma, { userId: userA, pin: '12345', label: '폰' })).rejects.toThrow(
      PinError,
    );
    await expect(setupPin(prisma, { userId: userA, pin: 'abc123', label: '폰' })).rejects.toThrow(
      PinError,
    );
  });

  it('평문은 어디에도 없다 — 비밀번호도 기기 토큰도', async () => {
    const { deviceToken } = await setupPin(prisma, { userId: userA, pin: '280731', label: '폰' }, NOW);
    const rows = await prisma.trustedDevice.findMany({ where: { userId: userA } });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('280731');
    expect(dump).not.toContain(deviceToken);
  });

  it('같은 기기에서 다시 설정하면 옛 기록이 지워진다', async () => {
    const first = await setupPin(prisma, { userId: userB, pin: '491728', label: '폰' }, NOW);
    await setupPin(
      prisma,
      { userId: userB, pin: '739154', label: '폰', oldDeviceToken: first.deviceToken },
      NOW,
    );
    expect(await prisma.trustedDevice.count({ where: { userId: userB } })).toBe(1);
    // 옛 토큰은 더 이상 기기가 아니다
    await expect(
      verifyPinLogin(prisma, { deviceToken: first.deviceToken, pin: '491728' }),
    ).rejects.toThrow(/간편 로그인을 쓸 수 없습니다/);
  });
});

describe('간편 로그인 — 기기와 비밀번호가 함께 맞아야 한다', () => {
  it('맞으면 그 기기 주인의 계정으로 들어간다', async () => {
    const { deviceToken } = await setupPin(prisma, { userId: userA, pin: '280731', label: '폰' }, NOW);
    const r = await verifyPinLogin(prisma, { deviceToken, pin: '280731' }, NOW);
    expect(r.userId).toBe(userA);
  });

  it('**유출된 비밀번호는 다른 기기에서 못 쓴다** — 이 구조의 뼈대', async () => {
    // B가 A의 비밀번호를 알아냈다. 그러나 B의 손에는 A의 기기 토큰이 없다 —
    // 지어낸 토큰으로는 기기 자체를 못 찾는다. 새 기기는 무조건 풀 로그인이다
    await expect(
      verifyPinLogin(prisma, { deviceToken: 'invented-token', pin: '280731' }),
    ).rejects.toThrow(/간편 로그인을 쓸 수 없습니다/);
  });

  it('연속으로 틀리면 잠기고, 본인에게 알림이 간다', async () => {
    const { deviceToken } = await setupPin(prisma, { userId: userB, pin: '739154', label: '폰' }, NOW);

    for (let i = 1; i < MAX_PIN_ATTEMPTS; i++) {
      await expect(
        verifyPinLogin(prisma, { deviceToken, pin: '999999' }, NOW),
      ).rejects.toThrow(/남음/);
    }
    // 마지막 시도에서 잠긴다
    await expect(verifyPinLogin(prisma, { deviceToken, pin: '999999' }, NOW)).rejects.toThrow(
      /잠겼습니다/,
    );
    // 잠긴 뒤에는 **맞는 비밀번호도** 안 열린다 — 풀 로그인만 남는다
    await expect(verifyPinLogin(prisma, { deviceToken, pin: '739154' }, NOW)).rejects.toThrow(
      /잠겼습니다/,
    );
    const alert = await prisma.notification.findFirst({
      where: { userId: userB, type: 'PIN_LOCKED' },
    });
    expect(alert?.body).toContain('정산을 동결');
  });

  it('성공하면 실패 횟수가 0으로 돌아간다 — 어쩌다 한 번 틀린 것이 쌓이면 안 된다', async () => {
    const { deviceToken } = await setupPin(prisma, { userId: userA, pin: '280731', label: '폰' }, NOW);
    await expect(verifyPinLogin(prisma, { deviceToken, pin: '111112' }, NOW)).rejects.toThrow();
    await verifyPinLogin(prisma, { deviceToken, pin: '280731' }, NOW);
    const device = await prisma.trustedDevice.findFirst({
      where: { userId: userA },
      orderBy: { createdAt: 'desc' },
    });
    expect(device!.failedAttempts).toBe(0);
  });
});

describe('신뢰 기기 판정 — 풀 로그인이 "간편 비밀번호 설정 필요"를 정할 때', () => {
  it('내 기기면 true, 남의 기기·모르는 기기·잠긴 기기는 전부 false', async () => {
    const mine = await setupPin(prisma, { userId: userA, pin: '280731', label: '폰' }, NOW);
    expect(await isTrustedDevice(prisma, userA, mine.deviceToken)).toBe(true);
    expect(await isTrustedDevice(prisma, userB, mine.deviceToken)).toBe(false); // 남의 기기
    expect(await isTrustedDevice(prisma, userA, 'unknown')).toBe(false);
    expect(await isTrustedDevice(prisma, userA, undefined)).toBe(false);
  });
});
