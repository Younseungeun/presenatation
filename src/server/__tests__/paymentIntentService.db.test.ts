import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  confirmPaymentIntent,
  createPaymentIntent,
  INTENT_TTL_MS,
  purgeExpiredPaymentIntents,
} from '../paymentIntentService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { createDraftReport, publishReport } from '../reportService';

// 토스페이먼츠 승인은 실제 네트워크를 타지 않고 fetch를 모킹해 우리 쪽 로직만 검증한다:
// 금액 대조, 소유권 확인, 중복 콜백 안전 처리, 승인 성공 시 purchaseReport 연결.

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;
let otherBuyerId: string;
let reportId: string;

const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');

function registry(ticker: string): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
      { date: '2026-07-12', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ]),
  };
}

beforeAll(async () => {
  prisma = createTestDb('pay-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@pay.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@pay.io', identityVerified: true } })).id;
  otherBuyerId = (
    await prisma.user.create({ data: { email: 'b2@pay.io', identityVerified: true } })
  ).id;

  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: '비트코인 전망',
      summary: 's',
      content: 'c',
      priceKrw: 15_000,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker: 'KRW-AAA',
        assetName: 'KRW-AAA',
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 20,
        confidence: 5,
        selfStability: 5,
        deadline: new Date('2026-12-01T00:00:00Z'),
      },
    },
    new Date('2026-07-11T00:00:00Z'),
  );
  await publishReport(prisma, registry('KRW-AAA'), draft.id, researcherId, PUBLISH_NOW);
  reportId = draft.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function mockTossOk(overrides: Record<string, unknown> = {}) {
  (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => ({
      paymentKey: 'test-payment-key',
      orderId: overrides.orderId,
      method: '카드',
      totalAmount: overrides.totalAmount ?? 15_000,
      status: 'DONE',
      approvedAt: '2026-07-12T00:00:00+09:00',
      card: { number: '433012******1234', cardType: '신용' },
      virtualAccount: null,
      ...overrides,
    }),
  });
}

describe('createPaymentIntent', () => {
  it('구매 가능한 리포트면 orderId·금액을 서버에 기록한다', async () => {
    const prepared = await createPaymentIntent(prisma, { reportId, buyerId }, PUBLISH_NOW);
    expect(prepared.amountKrw).toBe(15_000);
    expect(prepared.orderId).toMatch(new RegExp(`^pi_${reportId}_[0-9a-f]{8}$`));

    const stored = await prisma.paymentIntent.findUnique({ where: { orderId: prepared.orderId } });
    expect(stored?.status).toBe('PENDING');
    expect(stored?.buyerId).toBe(buyerId);
  });

  it('자기 리포트는 결제 의도를 만들 수 없다 (purchaseReport와 동일 검증 공유)', async () => {
    const sellerUserId = (
      await prisma.researcherProfile.findUniqueOrThrow({ where: { id: researcherId } })
    ).userId;
    await expect(
      createPaymentIntent(prisma, { reportId, buyerId: sellerUserId }, PUBLISH_NOW),
    ).rejects.toThrow('자기 리포트');
  });
});

describe('confirmPaymentIntent', () => {
  it('금액이 다르면 승인하지 않고 FAILED로 남긴다', async () => {
    const prepared = await createPaymentIntent(prisma, { reportId, buyerId }, PUBLISH_NOW);
    await expect(
      // now를 넘긴다 — 의도에 유효기간이 생겨(INTENT_TTL_MS) 픽스처 시각으로 만든 의도를
      // 실제 시계로 승인하려 하면 만료로 먼저 걸린다
      confirmPaymentIntent(
        prisma,
        { orderId: prepared.orderId, paymentKey: 'k', clientAmount: 99_999, buyerId },
        PUBLISH_NOW,
      ),
    ).rejects.toThrow('결제 금액이 일치하지 않습니다');

    expect(fetch).not.toHaveBeenCalled(); // 금액이 어긋나면 토스 승인 API를 아예 부르지 않는다
    const stored = await prisma.paymentIntent.findUnique({ where: { orderId: prepared.orderId } });
    expect(stored?.status).toBe('FAILED');
  });

  // **만료된 의도로는 승인하지 않는다.** 돈이 빠진 뒤 되돌리는 것보다 안 나가는 게 낫다 —
  // 결제창을 열어둔 채 시간이 흐르면 그 사이 시세·판매 상태가 완전히 달라져 있다
  it('유효시간이 지난 의도는 승인하지 않고 EXPIRED로 닫는다', async () => {
    const prepared = await createPaymentIntent(prisma, { reportId, buyerId }, PUBLISH_NOW);
    const tooLate = new Date(PUBLISH_NOW.getTime() + INTENT_TTL_MS + 1_000);

    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: prepared.orderId, paymentKey: 'k', clientAmount: prepared.amountKrw, buyerId },
        tooLate,
      ),
    ).rejects.toThrow(/유효시간이 지났습니다/);

    expect(fetch).not.toHaveBeenCalled(); // 토스 승인 API를 아예 부르지 않는다 = 돈이 안 나간다
    const stored = await prisma.paymentIntent.findUnique({ where: { orderId: prepared.orderId } });
    expect(stored?.status).toBe('EXPIRED');

    // 정리 배치가 지운다 — orderId에 reportId가 박혀 있어 "누가 무엇을 사려다 말았는지"가
    // 남으면 구매 전 마스킹 규칙 밖에 있는 표가 된다
    expect(await purgeExpiredPaymentIntents(prisma, tooLate)).toBeGreaterThan(0);
    expect(await prisma.paymentIntent.findUnique({ where: { orderId: prepared.orderId } })).toBeNull();
  });

  it('돈이 움직인 흔적은 정리 대상이 아니다 — 지우면 분쟁에서 근거가 사라진다', async () => {
    const prepared = await createPaymentIntent(prisma, { reportId, buyerId }, PUBLISH_NOW);
    await prisma.paymentIntent.update({
      where: { orderId: prepared.orderId },
      data: { status: 'REQUIRES_MANUAL_VOID' },
    });
    const muchLater = new Date(PUBLISH_NOW.getTime() + 365 * 86_400_000);

    await purgeExpiredPaymentIntents(prisma, muchLater);
    const kept = await prisma.paymentIntent.findUnique({ where: { orderId: prepared.orderId } });
    expect(kept?.status).toBe('REQUIRES_MANUAL_VOID'); // 아직 안 끝난 사고다
  });

  it('본인 결제가 아니면 거부한다', async () => {
    const prepared = await createPaymentIntent(prisma, { reportId, buyerId }, PUBLISH_NOW);
    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: prepared.orderId, paymentKey: 'k', clientAmount: 15_000, buyerId: otherBuyerId },
        PUBLISH_NOW,
      ),
    ).rejects.toThrow('본인의 결제가 아닙니다');
  });

  it('승인에 성공하면 구매가 생성되고 결제 정보에 토스 응답이 반영된다', async () => {
    const prepared = await createPaymentIntent(prisma, { reportId, buyerId }, PUBLISH_NOW);
    mockTossOk({ orderId: prepared.orderId });

    const purchase = await confirmPaymentIntent(
      prisma,
      { orderId: prepared.orderId, paymentKey: 'test-payment-key', clientAmount: 15_000, buyerId },
      PUBLISH_NOW,
    );

    expect(purchase.amountKrw).toBe(15_000);
    expect(purchase.paymentMethod).toBe('CARD');
    expect(purchase.paymentInfo).toContain('433012******1234');
    expect(purchase.paymentInfo).toContain('토스페이먼츠');

    const intent = await prisma.paymentIntent.findUnique({ where: { orderId: prepared.orderId } });
    expect(intent?.status).toBe('CONFIRMED');

    // fetch가 우리 서버 금액(intent.amountKrw)으로 승인 요청했는지 — 클라이언트 값을 신뢰하지 않는다
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.amount).toBe(15_000);
  });

  it('같은 orderId로 다시 호출되면(중복 콜백) 재승인 없이 기존 구매를 반환한다', async () => {
    const prepared = await createPaymentIntent(prisma, { reportId, buyerId: otherBuyerId }, PUBLISH_NOW);
    mockTossOk({ orderId: prepared.orderId });

    const first = await confirmPaymentIntent(
      prisma,
      {
        orderId: prepared.orderId,
        paymentKey: 'test-payment-key',
        clientAmount: 15_000,
        buyerId: otherBuyerId,
      },
      PUBLISH_NOW,
    );
    const callsAfterFirst = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    const second = await confirmPaymentIntent(
      prisma,
      {
        orderId: prepared.orderId,
        paymentKey: 'test-payment-key',
        clientAmount: 15_000,
        buyerId: otherBuyerId,
      },
      PUBLISH_NOW,
    );

    expect(second.id).toBe(first.id);
    // 두 번째 호출은 토스 승인 API를 다시 부르지 않는다
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });

  it('토스 승인 API가 실패를 돌려주면 에러 메시지를 그대로 전달한다', async () => {
    const draft2 = await createDraftReport(
      prisma,
      {
        researcherId,
        title: '이더리움 전망',
        summary: 's',
        content: 'c',
        priceKrw: 12_000,
        prepaymentRatio: 0,
        card: {
          assetClass: 'CRYPTO',
          ticker: 'KRW-BBB',
          assetName: 'KRW-BBB',
          direction: 'UP',
          targetType: 'RETURN_PCT',
          targetValue: 20,
          confidence: 5,
          selfStability: 5,
          deadline: new Date('2026-12-01T00:00:00Z'),
        },
      },
      new Date('2026-07-11T00:00:00Z'),
    );
    await publishReport(prisma, registry('KRW-BBB'), draft2.id, researcherId, PUBLISH_NOW);

    const prepared = await createPaymentIntent(
      prisma,
      { reportId: draft2.id, buyerId },
      PUBLISH_NOW,
    );
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ code: 'NOT_FOUND_PAYMENT_SESSION', message: '결제 시간이 만료되었습니다' }),
    });

    await expect(
      confirmPaymentIntent(
        prisma,
        { orderId: prepared.orderId, paymentKey: 'k', clientAmount: 12_000, buyerId },
        PUBLISH_NOW,
      ),
    ).rejects.toThrow('결제 시간이 만료되었습니다');
  });
});
