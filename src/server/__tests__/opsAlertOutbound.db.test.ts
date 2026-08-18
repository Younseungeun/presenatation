import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { notifyOperators } from '../opsAlert';

// **시험이 실제 경보 채널로 나가면 안 된다** (2026-08-18, 실제 사고의 회귀 방지).
//
// 텔레그램을 붙인 날 밤 `npm test` 한 번에 창업자 폰으로 가짜 경보 수십 통이 갔다.
// 시험이 만든 값("AAA 종목", "newcomer", 8,000원 보상)이 실제 채널에 그대로 흘렀다.
//
// 두 가지가 겹쳐서 생긴 일이라 둘 다 기억해 둘 값어치가 있다:
//   ① `OPS_WEBHOOK_URL`이 한 번도 설정된 적이 없어 이 경로가 늘 조용히 빠져나갔다 —
//      **채널을 실제로 연결하는 순간** 잠재해 있던 문제가 살아났다
//   ② vitest는 `.env`를 안 읽는데 **Prisma Client가 스스로 읽는다** — DB 갈래는
//      PrismaClient를 임포트하는 순간 `.env` 전체가 process.env에 얹힌다
//
// 이 시험이 지키는 성질: **경보를 부르면 앱 안 알림은 생기고 네트워크는 안 나간다.**
// 두 쪽을 함께 봐야 한다 — 밖을 막으면서 안까지 막아 버리면 다른 시험들이
// "알림이 생겼는가"로 검사하는 것들이 통째로 무너진다.

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createTestDb('ops-outbound-');
  await prisma.user.create({
    data: { id: 'op-outbound', email: 'op@outbound.io', role: 'OPERATOR' },
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

it('경보는 앱 안에만 쌓이고 밖으로는 한 통도 안 나간다', async () => {
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);

  await notifyOperators(prisma, {
    title: '[시험] 나가면 안 되는 경보',
    body: '이 문장이 실제 폰에 뜨면 이 시험이 실패한 것이다',
  });

  // 밖으로 나가는 길은 전부 막혀 있다 (웹훅·텔레그램)
  expect(fetchSpy).not.toHaveBeenCalled();

  // 앱 안 알림은 그대로 — 막는 것은 네트워크뿐이다
  expect(
    await prisma.notification.count({ where: { userId: 'op-outbound', type: 'OPS_ALERT' } }),
  ).toBe(1);
});

// **이 시험이 뜻을 가지려면 VITEST가 켜져 있어야 한다.**
//
// 값을 나중에 바꿔 넣는 시험은 쓰지 않았다 — 텔레그램 설정은 **모듈 임포트 시점에**
// 상수로 굳으므로, 시험 안에서 process.env를 고쳐도 그 상수는 안 바뀐다. 그런 시험은
// 통과하지만 아무것도 증명하지 못한다(위 시험이 이미 진짜 설정으로 돌고 있다 —
// 이 기계의 .env를 Prisma가 읽어 두기 때문이다).
//
// 대신 관문의 전제를 고정한다: 실행기가 이 값을 켜 주지 않으면 위 시험은
// "막혀서 안 나간 것"이 아니라 "설정이 없어서 안 나간 것"이 되어 조용히 무력해진다.
it('관문의 전제 — 시험 실행기가 VITEST를 켠다', () => {
  expect(process.env.VITEST).toBeTruthy();
});
