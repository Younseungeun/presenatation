import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';

// **PG 승인 뒤에 구매 생성이 실패하면 반드시 되돌려야 한다.**
//
// 결제 흐름은 ① 의도 기록 → ② PG 승인(**돈이 빠진다**) → ③ 구매 생성 → ④ CONFIRMED다.
// ③은 구매 가능 여부를 다시 검사하므로(판매 기간·판정 여부·규율 상한·실시간 시세)
// 사용자가 결제창에 머무는 사이 상태가 바뀌면 던진다. 되돌리지 않으면
// **돈은 빠졌는데 구매 행이 없는 상태**가 남고, 의도는 PENDING이라 아무도 못 찾는다.
//
// 재검증을 없애는 선택지는 쓰지 않는다 — 이미 판정된 카드가 팔리면 정산이 꼬인다.
// 잘못 파는 것보다 승인 취소가 낫다.

const cancelCalls: { paymentKey: string; cancelReason: string }[] = [];
let cancelShouldFail = false;

vi.mock('../tossPayments', () => ({
  TossPaymentError: class TossPaymentError extends Error {
    constructor(
      message: string,
      readonly code?: string,
    ) {
      super(message);
      this.name = 'TossPaymentError';
    }
  },
  confirmTossPayment: vi.fn(async (p: { orderId: string; amount: number }) => ({
    paymentKey: 'pk_test',
    orderId: p.orderId,
    method: '카드',
    totalAmount: p.amount,
    status: 'DONE',
    approvedAt: new Date().toISOString(),
    card: null,
    virtualAccount: null,
  })),
  cancelTossPayment: vi.fn(async (p: { paymentKey: string; cancelReason: string }) => {
    cancelCalls.push(p);
    if (cancelShouldFail) throw new Error('PG 장애');
    return { paymentKey: p.paymentKey, status: 'CANCELED' };
  }),
  describeTossPayment: () => '카드 결제(모의)',
  TOSS_CLIENT_KEY: 'test',
}));

let prisma: PrismaClient;
let buyerId: string;
let reportId: string;

const NOW = new Date('2026-08-20T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('payment-void-');
  await seedTestInstruments(prisma);

  const seller = await prisma.user.create({
    data: {
      email: 's@t.io',
      identityVerified: true,
      researcherProfile: { create: { tier: 'BRONZE' } },
    },
    include: { researcherProfile: true },
  });
  const buyer = await prisma.user.create({
    data: { email: 'b@t.io', identityVerified: true },
  });
  buyerId = buyer.id;

  const report = await prisma.report.create({
    data: {
      researcherId: seller.researcherProfile!.id,
      title: 't',
      summary: 's',
      content: 'c',
      priceKrw: 20_000,
      status: 'PUBLISHED',
      publishedAt: new Date('2026-08-19T00:00:00Z'),
      feeRateBp: 2000,
      predictionCard: {
        create: {
          assetClass: 'CRYPTO',
          ticker: 'KRW-BTC',
          currency: 'KRW',
          assetName: 'BTC',
          direction: 'UP',
          targetType: 'RETURN_PCT',
          targetValue: 20,
          basePrice: 100,
          deadline: new Date('2026-09-30T00:00:00Z'),
          confidence: 5,
        },
      },
    },
  });
  reportId = report.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  cancelCalls.length = 0;
  cancelShouldFail = false;
  await prisma.paymentIntent.deleteMany({});
  await prisma.purchase.deleteMany({});
  await prisma.notification.deleteMany({});
});

/** 구매 생성이 실패하도록 리포트를 판매 불가 상태로 만든다 */
async function makeUnsellable() {
  await prisma.report.update({
    where: { id: reportId },
    data: { salesClosedAt: new Date('2026-08-19T12:00:00Z') },
  });
}
async function makeSellable() {
  await prisma.report.update({ where: { id: reportId }, data: { salesClosedAt: null } });
}

async function seedIntent(orderId: string) {
  await prisma.paymentIntent.create({
    data: { orderId, buyerId, reportId, amountKrw: 20_000, status: 'PENDING' },
  });
}

describe('승인 후 구매 생성 실패 — 보상 트랜잭션', () => {
  it('구매 생성이 실패하면 승인을 자동으로 취소하고 CANCELLED로 남긴다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');
    await makeUnsellable();
    await seedIntent('order-1');

    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: 'order-1', paymentKey: 'pk_test', clientAmount: 20_000, buyerId },
        NOW,
      ),
    ).rejects.toThrow(/판매가 마감/);

    // 취소가 실제로 호출됐다
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0].paymentKey).toBe('pk_test');
    expect(cancelCalls[0].cancelReason).toContain('구매 생성 실패');

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { orderId: 'order-1' } });
    expect(intent.status).toBe('CANCELLED');
    // 구매는 만들어지지 않았다
    expect(await prisma.purchase.count()).toBe(0);
    await makeSellable();
  });

  it('취소마저 실패하면 REQUIRES_MANUAL_VOID로 남긴다 — 돈이 PG에 잡혀 있다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');
    await makeUnsellable();
    await seedIntent('order-2');
    cancelShouldFail = true;

    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: 'order-2', paymentKey: 'pk_test', clientAmount: 20_000, buyerId },
        NOW,
      ),
    ).rejects.toThrow();

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { orderId: 'order-2' } });
    expect(intent.status).toBe('REQUIRES_MANUAL_VOID');
    await makeSellable();
  });

  it('실패 사유를 그대로 올린다 — 구매자에게는 왜 막혔는지가 답이다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');
    await makeUnsellable();
    await seedIntent('order-3');

    // "취소했습니다"가 아니라 원래 사유가 올라와야 한다
    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: 'order-3', paymentKey: 'pk_test', clientAmount: 20_000, buyerId },
        NOW,
      ),
    ).rejects.toThrow(/판매가 마감된 리포트/);
    await makeSellable();
  });

  it('정상 경로는 그대로 — 취소를 부르지 않는다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');
    await makeSellable();
    await seedIntent('order-4');

    const purchase = await confirmPaymentIntent(
      prisma,
      { orderId: 'order-4', paymentKey: 'pk_test', clientAmount: 20_000, buyerId },
      NOW,
    );
    expect(purchase.reportId).toBe(reportId);
    expect(cancelCalls).toHaveLength(0);
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { orderId: 'order-4' } });
    expect(intent.status).toBe('CONFIRMED');
  });

  it('금액 불일치는 승인 **전에** 막힌다 — 돈이 빠지지 않으므로 취소도 없다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');
    await seedIntent('order-5');

    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: 'order-5', paymentKey: 'pk_test', clientAmount: 19_000, buyerId },
        NOW,
      ),
    ).rejects.toThrow(/금액이 일치하지 않습니다/);

    expect(cancelCalls).toHaveLength(0);
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { orderId: 'order-5' } });
    expect(intent.status).toBe('FAILED');
  });
});
