import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { FcmPushProvider } from '@/infra/push/fcm';
import { FixturePushProvider } from '@/infra/push/provider';
import { createTestDb } from './helpers/testDb';
import {
  flushPendingPush,
  PUSH_MAX_AGE_MS,
  registerPushSubscription,
  setPushProviderForTests,
  unregisterPushSubscription,
} from '../pushService';

// 푸시는 **인앱 알림의 사본**이고, 스윕이 그 사본을 만든다.
// 여기서 지키는 성질은 넷이다:
//   ① 같은 알림이 두 번 울리지 않는다 (돈 얘기가 두 번 오면 사고로 읽힌다)
//   ② 죽은 기기는 지워진다 (안 지우면 발송마다 헛돌고 표가 영원히 자란다)
//   ③ 밀린 알림이 한꺼번에 쏟아지지 않는다 (스케줄러가 하루 죽었다 살아난 경우)
//   ④ **시험에서는 네트워크로 안 나간다** — opsAlert 사고(2026-08-18)의 재발 방지.
//      받는 사람이 운영자 한 명이 아니라 이용자 전원이라 저쪽보다 더 나쁘다

let prisma: PrismaClient;
const USER = 'push-u1';
const OTHER = 'push-u2';

beforeAll(async () => {
  prisma = createTestDb('push-sweep-');
  for (const [id, email] of [
    [USER, 'p1@example.com'],
    [OTHER, 'p2@example.com'],
  ]) {
    await prisma.user.create({ data: { id, email } });
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.notification.deleteMany({});
  await prisma.pushSubscription.deleteMany({});
  setPushProviderForTests(undefined);
});

async function noti(userId: string, type: string, createdAt = new Date()) {
  return prisma.notification.create({
    data: { userId, type, title: 't', body: 'b', link: '/x', createdAt },
  });
}

it('공급자가 없으면 아무 일도 안 일어난다 — 반쯤 켜진 상태가 가장 나쁘다', async () => {
  setPushProviderForTests(null);
  await noti(USER, 'JUDGMENT_RESULT');
  const r = await flushPendingPush(prisma);
  expect(r.attempted).toBe(0);
  const row = await prisma.notification.findFirst({ where: { userId: USER } });
  expect(row?.pushedAt).toBeNull(); // 표시도 안 한다 — 나중에 붙이는 날을 위해 남겨 둔다
});

it('같은 알림을 두 번 보내지 않는다 — 스윕이 여러 번 돌아도 안전하다', async () => {
  const p = new FixturePushProvider();
  setPushProviderForTests(p);
  await registerPushSubscription(prisma, { userId: USER, token: 'tok-a', platform: 'ios' });
  await noti(USER, 'JUDGMENT_RESULT');

  const first = await flushPendingPush(prisma);
  expect(first.attempted).toBe(1);
  const second = await flushPendingPush(prisma);
  expect(second.attempted).toBe(0);
});

it('기기가 없어도 보낸 것으로 표시한다 — 안 그러면 스윕이 매번 같은 행을 헛되이 훑는다', async () => {
  setPushProviderForTests(new FixturePushProvider());
  await noti(OTHER, 'REFUND_EXECUTED');
  const r = await flushPendingPush(prisma);
  expect(r.noDevice).toBe(1);
  expect(r.attempted).toBe(0);
  const row = await prisma.notification.findFirst({ where: { userId: OTHER } });
  expect(row?.pushedAt).not.toBeNull();
});

it('공급자가 "죽었다"고 답한 구독은 즉시 지운다', async () => {
  setPushProviderForTests(new FixturePushProvider(new Set(['tok-dead'])));
  await registerPushSubscription(prisma, { userId: USER, token: 'tok-dead', platform: 'android' });
  await registerPushSubscription(prisma, { userId: USER, token: 'tok-live', platform: 'ios' });
  await noti(USER, 'JUDGMENT_RESULT');

  const r = await flushPendingPush(prisma);
  expect(r.pruned).toBe(1);
  expect(r.delivered).toBe(1); // 살아 있는 기기 한 대에는 갔다
  const left = await prisma.pushSubscription.findMany({ where: { userId: USER } });
  expect(left.map((s) => s.token)).toEqual(['tok-live']);
});

it('일시 실패는 세기만 하고 지우지 않는다 — 공급자 장애 한 번에 전원을 날리면 안 된다', async () => {
  setPushProviderForTests(new FixturePushProvider(new Set(), new Set(['tok-flaky'])));
  await registerPushSubscription(prisma, { userId: USER, token: 'tok-flaky', platform: 'web' });
  await noti(USER, 'JUDGMENT_RESULT');

  const r = await flushPendingPush(prisma);
  expect(r.pruned).toBe(0);
  const s = await prisma.pushSubscription.findUnique({ where: { token: 'tok-flaky' } });
  expect(s?.failCount).toBe(1);
});

it('오래된 알림은 울리지 않고 표시만 한다 — 어제 판정이 새벽에 진동하면 알림을 꺼 버린다', async () => {
  const p = new FixturePushProvider();
  setPushProviderForTests(p);
  await registerPushSubscription(prisma, { userId: USER, token: 'tok-a', platform: 'ios' });
  await noti(USER, 'JUDGMENT_RESULT', new Date(Date.now() - PUSH_MAX_AGE_MS - 60_000));

  const r = await flushPendingPush(prisma);
  expect(r.tooOld).toBe(1);
  expect(r.attempted).toBe(0);
  expect(p.sent).toHaveLength(0);
});

it('운영자 경보는 푸시로 안 나간다 — 텔레그램이 이미 그 일을 한다', async () => {
  const p = new FixturePushProvider();
  setPushProviderForTests(p);
  await registerPushSubscription(prisma, { userId: USER, token: 'tok-a', platform: 'ios' });
  await noti(USER, 'OPS_ALERT');

  const r = await flushPendingPush(prisma);
  expect(r.attempted).toBe(0);
  expect(p.sent).toHaveLength(0);
});

it('같은 토큰이 다른 계정으로 오면 주인이 바뀐다 — 전 주인 알림이 새 주인 폰에 뜨면 안 된다', async () => {
  await registerPushSubscription(prisma, { userId: USER, token: 'tok-shared', platform: 'ios' });
  await registerPushSubscription(prisma, { userId: OTHER, token: 'tok-shared', platform: 'ios' });
  const rows = await prisma.pushSubscription.findMany({ where: { token: 'tok-shared' } });
  expect(rows).toHaveLength(1);
  expect(rows[0].userId).toBe(OTHER);
});

it('구독 해지는 멱등하다 — 없는 토큰을 지워도 터지지 않는다', async () => {
  expect(await unregisterPushSubscription(prisma, 'never-existed')).toBe(0);
});

it('**진짜 공급자를 꽂아도 시험 중에는 네트워크로 안 나간다** (opsAlert 사고 회귀 방지)', async () => {
  // 가짜 공급자로 검사하면 아무것도 증명하지 못한다 — 가짜는 원래 네트워크를 안 쓴다.
  // **실제 FCM 어댑터**를 꽂고, 그런데도 fetch가 한 번도 안 불리는지를 본다
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  setPushProviderForTests(
    new FcmPushProvider({ projectId: 'p', clientEmail: 'e@x', privateKey: 'not-a-key' }),
  );
  await registerPushSubscription(prisma, { userId: USER, token: 'tok-a', platform: 'ios' });
  await noti(USER, 'PAYOUT_ACCOUNT_CHANGED');

  const r = await flushPendingPush(prisma);
  // 표시는 한다 — 막는 것은 발송뿐이고, 가드가 데이터를 바꾸면 가드가 아니라 버그다
  expect(r.attempted).toBe(1);
  expect(fetchSpy).not.toHaveBeenCalled();
  // 성공한 척하므로 살아 있는 구독이 잘려 나가지 않는다
  expect(await prisma.pushSubscription.count({ where: { userId: USER } })).toBe(1);
  fetchSpy.mockRestore();
});

it('VITEST가 참이라는 것이 위 가드의 전제다', () => {
  expect(process.env.VITEST).toBeTruthy();
});
