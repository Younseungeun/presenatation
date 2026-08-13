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

const cancelCalls: { paymentKey: string; cancelReason: string; idempotencyKey?: string }[] = [];
let cancelShouldFail = false;
/** 승인 응답에 덮어씌울 필드 — 가상계좌·입금대기 응답을 만들 때 쓴다 */
let confirmOverride: Record<string, unknown> = {};

// **네트워크 호출만 가짜로 만든다.** pendingDepositReason은 진짜를 그대로 쓴다 —
// "이 응답을 받으면 팔면 안 된다"는 판단 자체가 이 파일이 지키려는 규칙이다
vi.mock('../tossPayments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tossPayments')>();
  return {
    ...actual,
    confirmTossPayment: vi.fn(async (p: { orderId: string; amount: number }) => ({
      paymentKey: 'pk_test',
      orderId: p.orderId,
      method: '카드',
      totalAmount: p.amount,
      status: 'DONE',
      approvedAt: new Date().toISOString(),
      card: null,
      virtualAccount: null,
      ...confirmOverride,
    })),
    cancelTossPayment: vi.fn(
      async (p: { paymentKey: string; cancelReason: string; idempotencyKey?: string }) => {
        cancelCalls.push(p);
        if (cancelShouldFail) throw new Error('PG 장애');
        return { paymentKey: p.paymentKey, status: 'CANCELED' };
      },
    ),
    describeTossPayment: () => '카드 결제(모의)',
  };
});

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
  confirmOverride = {};
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
    expect(cancelCalls[0].cancelReason).toContain('판매가 마감된 리포트');
    // 같은 successUrl이 두 번 열려도 취소는 한 번이다
    expect(cancelCalls[0].idempotencyKey).toBe('void_order-1');

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

  it('결제 키를 구매에 남긴다 — 환불을 자동으로 실행하려면 이게 있어야 한다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');
    await makeSellable();
    await seedIntent('order-6');

    const purchase = await confirmPaymentIntent(
      prisma,
      { orderId: 'order-6', paymentKey: 'pk_test', clientAmount: 20_000, buyerId },
      NOW,
    );
    expect(purchase.paymentKey).toBe('pk_test');
    expect(purchase.paymentMethod).toBe('CARD');
  });
});

// **승인 API가 200을 돌려줬다고 돈이 들어온 것이 아니다.**
//
// 가상계좌를 고르면 토스는 계좌를 발급하고 status: "WAITING_FOR_DEPOSIT"으로 **성공
// 응답**을 준다. 이 구분을 안 하면 입금 전에 구매가 만들어져 리포트가 열린다 —
// 무통장입금을 고르고 입금하지 않는 쪽이 이득이 된다.
//
// 입금이 끝나도 문제가 남는다: 계좌를 받는 시각과 넣는 시각 사이에 시세가 움직이면
// "결제가 승인되는 순간 광고 폭의 절반 이상"이라는 고지가 깨진다. 그 고지를 집행하는
// 관문(assertNotSuspendedIntraday)은 **누르는 그 순간**을 재는 장치라 걸릴 자리가 없다.
describe('입금이 나중에 이뤄지는 결제 수단은 받지 않는다', () => {
  it('가상계좌 응답이면 구매를 만들지 않고 발급된 계좌를 닫는다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');
    await makeSellable();
    await seedIntent('order-vb');
    confirmOverride = {
      method: '가상계좌',
      status: 'WAITING_FOR_DEPOSIT',
      approvedAt: null,
      virtualAccount: { bankCode: '088', accountNumber: '1234', dueDate: '2026-08-27T00:00:00' },
    };

    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: 'order-vb', paymentKey: 'pk_vb', clientAmount: 20_000, buyerId },
        NOW,
      ),
    ).rejects.toThrow(/가상계좌\(무통장입금\)으로는 결제할 수 없습니다/);

    // 리포트가 열리지 않았다 — 이게 이 검사의 본론이다
    expect(await prisma.purchase.count()).toBe(0);
    // 발급된 계좌를 그대로 두면 나중에 입금이 들어와 붕 뜬다
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0].paymentKey).toBe('pk_vb');
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { orderId: 'order-vb' } });
    expect(intent.status).toBe('CANCELLED');
  });

  it('가상계좌가 아니어도 DONE이 아니면 막는다 — 상태를 신뢰의 기준으로 삼는다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');
    await makeSellable();
    await seedIntent('order-wait');
    confirmOverride = { status: 'WAITING_FOR_DEPOSIT' };

    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: 'order-wait', paymentKey: 'pk_w', clientAmount: 20_000, buyerId },
        NOW,
      ),
    ).rejects.toThrow(/입금 대기 상태\(WAITING_FOR_DEPOSIT\)/);
    expect(await prisma.purchase.count()).toBe(0);
  });

  it('스텁 구매 경로도 무통장입금을 거절한다 — 조용히 카드로 바꾸지 않는다', async () => {
    const { assertAcceptedPaymentMethod } = await import('../purchaseService');
    expect(() => assertAcceptedPaymentMethod('VBANK')).toThrow(/무통장입금\(가상계좌\)/);
    expect(() => assertAcceptedPaymentMethod('CARD')).not.toThrow();
    expect(() => assertAcceptedPaymentMethod(undefined)).not.toThrow(); // 화면이 더는 보내지 않는다
  });

  // 즉시 승인되는 수단은 카드만이 아니다 — 계좌이체·간편결제는 승인 즉시 돈이 빠지므로
  // q 드리프트가 없고, 카드가 없는 사람의 길을 막을 이유가 없다.
  // 반대로 휴대폰·상품권은 즉시 승인돼도 **부분 취소**가 안 돼서 받지 않는다:
  // 실패(MISS) 시 성과 연동분만 돌려주는 것이 이 상품의 기본 환불이다
  it('실시간 계좌이체·간편결제는 받고, 부분 취소가 안 되는 수단은 되돌린다', async () => {
    const { confirmPaymentIntent } = await import('../paymentIntentService');

    await makeSellable();
    await seedIntent('order-tr');
    confirmOverride = { method: '계좌이체' };
    const bought = await confirmPaymentIntent(
      prisma,
      { orderId: 'order-tr', paymentKey: 'pk_tr', clientAmount: 20_000, buyerId },
      NOW,
    );
    expect(bought.paymentMethod).toBe('TRANSFER');
    expect(cancelCalls).toHaveLength(0);

    await prisma.purchase.deleteMany({});
    await seedIntent('order-ph');
    confirmOverride = { method: '휴대폰' };
    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: 'order-ph', paymentKey: 'pk_ph', clientAmount: 20_000, buyerId },
        NOW,
      ),
    ).rejects.toThrow(/부분 취소가 되지 않습니다/);
    expect(await prisma.purchase.count()).toBe(0);
    expect(cancelCalls).toHaveLength(1); // 승인됐으니 되돌린다
  });
});
