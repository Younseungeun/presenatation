import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  listLoginDevices,
  notifyNewDevice,
  removeLoginDevice,
  revokeAllSessions,
} from '../deviceService';
import { setupPin } from '../pinService';

// 로그인 기기 관리 — **지우는 것과 끊는 것은 다른 일이다.**
//
// 검토 2차 Q1의 보완책이 이 파일이다: 유심을 가로챈 쪽이 간편 비밀번호를 심으면
// 그가 얻는 것은 추가 권한이 아니라 **지속성**이다(유심을 돌려준 뒤에도 남는 접근).
// 그것을 상쇄하는 것이 ① 새 기기 알림과 ② 원격 삭제인데, 삭제가 **이미 열려 있는
// 창까지 닫지 못하면** 반쪽이다. 그래서 삭제가 세션 세대를 함께 올린다.

let prisma: PrismaClient;
let userA: string;
let userB: string;
const NOW = new Date('2026-08-16T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('device-');
  const a = await prisma.user.create({
    data: { email: 'a@dev.io', identityVerified: true, identityHash: 'dev-a' },
  });
  const b = await prisma.user.create({
    data: { email: 'b@dev.io', identityVerified: true, identityHash: 'dev-b' },
  });
  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('목록 — 생체와 간편을 한 자리에서 본다', () => {
  it('두 종류가 한 목록에 함께 나온다', async () => {
    await prisma.passkey.create({
      data: { userId: userA, credentialId: 'd-cred', publicKey: 'pk', counter: 0, label: '내 폰(지문)', createdAt: NOW },
    });
    await setupPin(prisma, { userId: userA, pin: '280731', label: '내 폰(비밀번호)' }, NOW);

    const devices = await listLoginDevices(prisma, userA);
    // 나눠서 보여 주면 잃어버린 폰을 지우려는 사람이 한쪽만 지우고 안심한다
    expect(devices.map((d) => d.kind).sort()).toEqual(['BIOMETRIC', 'PIN']);
  });

  it('남의 기기는 안 보인다', async () => {
    expect(await listLoginDevices(prisma, userB)).toEqual([]);
  });
});

describe('세션 세대 — 강제 로그아웃의 유일한 수단', () => {
  it('올리면 이전 세대의 토큰이 전부 죽는다', async () => {
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userA },
      select: { sessionEpoch: true },
    });
    await revokeAllSessions(prisma, userA);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userA },
      select: { sessionEpoch: true },
    });
    // 세션 토큰은 무상태 서명이라 개별 폐기가 안 된다 — 세대가 그 자리를 대신한다
    expect(after.sessionEpoch).toBe(before.sessionEpoch + 1);
  });
});

describe('삭제 — 지우는 것만으로는 부족하다', () => {
  it('**기기를 지우면 세션도 함께 끊긴다**', async () => {
    const devices = await listLoginDevices(prisma, userA);
    const target = devices[0];
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userA },
      select: { sessionEpoch: true },
    });

    await removeLoginDevice(prisma, { userId: userA, deviceId: target.id, kind: target.kind }, NOW);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userA },
      select: { sessionEpoch: true },
    });
    // 이것이 없으면 "지웠는데 그 사람은 아직 들어와 있습니다"가 된다
    expect(after.sessionEpoch).toBe(before.sessionEpoch + 1);
    expect((await listLoginDevices(prisma, userA)).map((d) => d.id)).not.toContain(target.id);
  });

  it('삭제 사실을 본인에게 알린다', async () => {
    const n = await prisma.notification.findFirst({
      where: { userId: userA, type: 'DEVICE_REMOVED' },
    });
    expect(n?.body).toContain('모든 기기에서 로그아웃');
  });

  it('**남의 기기는 못 지운다**', async () => {
    await setupPin(prisma, { userId: userB, pin: '491728', label: 'B의 폰' }, NOW);
    const bDevice = (await listLoginDevices(prisma, userB))[0];
    await expect(
      removeLoginDevice(prisma, { userId: userA, deviceId: bDevice.id, kind: 'PIN' }, NOW),
    ).rejects.toThrow(/등록된 기기가 아닙니다/);
    expect(await listLoginDevices(prisma, userB)).toHaveLength(1);
  });

  it('마지막 한 대도 지울 수 있다 — 잃어버린 기기를 못 지우면 그게 더 나쁘다', async () => {
    const remaining = await listLoginDevices(prisma, userA);
    for (const d of remaining) {
      await removeLoginDevice(prisma, { userId: userA, deviceId: d.id, kind: d.kind }, NOW);
    }
    // 전부 지워도 계정은 안 잠긴다 — 본인 인증으로 다시 들어온다
    expect(await listLoginDevices(prisma, userA)).toEqual([]);
  });
});

describe('새 기기 알림 — 지속성을 상쇄하는 유일한 신호', () => {
  it('두 번째 기기부터 알린다', async () => {
    await prisma.notification.deleteMany({ where: { userId: userB } });
    // 기기가 하나뿐일 때(가입 직후)는 알릴 상대가 없다
    expect(await notifyNewDevice(prisma, { userId: userB, label: '폰', kind: 'PIN' }, NOW)).toBe(
      false,
    );

    await prisma.passkey.create({
      data: { userId: userB, credentialId: 'b-cred2', publicKey: 'pk', counter: 0, label: '두 번째' },
    });
    expect(
      await notifyNewDevice(prisma, { userId: userB, label: '두 번째', kind: 'BIOMETRIC' }, NOW),
    ).toBe(true);

    const n = await prisma.notification.findFirst({
      where: { userId: userB, type: 'DEVICE_ADDED' },
    });
    // 무엇을 해야 하는지까지 말해야 알림이 방어가 된다
    expect(n?.body).toContain('삭제하고 정산을 동결');
  });
});
