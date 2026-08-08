import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { addToCart, checkoutCart, countCart, getCart, removeFromCart } from '../cartService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { createDraftReport, publishReport } from '../reportService';

// 장바구니: 담기 검증 → 일괄 결제 → 결제 가능/불가 분리

let prisma: PrismaClient;
let researcherId: string;
let researcherUserId: string;
let buyerId: string;
let liveA: string;
let liveB: string;
let expiring: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');

function registry(ticker: string): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
      { date: '2026-07-12', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ]),
  };
}

async function publish(ticker: string, deadline: Date, priceKrw = 10_000) {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: `${ticker} 전망`,
      summary: 's',
      content: 'c',
      priceKrw,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker,
        assetName: ticker,
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 20,
        confidence: 5,
        selfStability: 5,
        deadline,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, registry(ticker), draft.id, researcherId, PUBLISH_NOW);
  return draft.id;
}

beforeAll(async () => {
  prisma = createTestDb('cart-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@cart.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  researcherUserId = r.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@cart.io', identityVerified: true } })).id;

  liveA = await publish('KRW-AAA', new Date('2026-12-01T00:00:00Z'), 10_000);
  liveB = await publish('KRW-BBB', new Date('2026-12-01T00:00:00Z'), 15_000);
  expiring = await publish('KRW-CCC', new Date('2026-08-01T00:00:00Z'), 12_000);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('addToCart — 담기 검증', () => {
  it('판매 중 리포트를 담고, 중복 담기는 오류 없이 1건으로 유지된다', async () => {
    await addToCart(prisma, buyerId, liveA);
    await addToCart(prisma, buyerId, liveA);
    expect(await countCart(prisma, buyerId)).toBe(1);
  });

  it('자기 리포트는 담을 수 없다', async () => {
    await expect(addToCart(prisma, researcherUserId, liveA)).rejects.toThrow('자기 리포트');
  });
});

describe('getCart — 결제 가능 여부 분리', () => {
  it('시한 지난 건은 결제 대상에서 빠지고 사유가 붙는다', async () => {
    await addToCart(prisma, buyerId, liveB);
    await addToCart(prisma, buyerId, expiring);

    // 시한(8/1)이 지난 시점에서 조회
    const cart = await getCart(prisma, buyerId, new Date('2026-08-02T00:00:00Z'));
    expect(cart.entries).toHaveLength(3);
    expect(cart.payableCount).toBe(2); // liveA + liveB
    expect(cart.payableKrw).toBe(25_000);

    const blocked = cart.entries.find((e) => e.reportId === expiring);
    expect(blocked!.issue).toBe('DEADLINE_PASSED');
  });
});

describe('checkoutCart — 일괄 결제', () => {
  it('결제 가능한 건만 구매하고 장바구니에서 빼며, 불가 건은 사유와 함께 남긴다', async () => {
    const result = await checkoutCart(prisma, buyerId, new Date('2026-08-02T00:00:00Z'));

    expect(result.purchased.sort()).toEqual([liveA, liveB].sort());
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reportId).toBe(expiring);

    // 구매는 에스크로 보관 상태로 생성된다
    const purchases = await prisma.purchase.findMany({ where: { buyerId } });
    expect(purchases).toHaveLength(2);
    expect(purchases.every((p) => p.escrowStatus === 'HELD')).toBe(true);
    expect(purchases.reduce((a, p) => a + p.amountKrw, 0)).toBe(25_000);
    // 결제 수단이 기록된다 (미지정 시 CARD 기본값 + 모의 마스킹 정보)
    expect(purchases.every((p) => p.paymentMethod === 'CARD')).toBe(true);
    expect(purchases.every((p) => p.paymentInfo && p.paymentInfo.includes('모의'))).toBe(true);

    // 성공 건만 빠지고 실패 건은 남는다
    expect(await countCart(prisma, buyerId)).toBe(1);
  });

  it('이미 구매한 리포트를 다시 담으면 담기 단계에서 막힌다', async () => {
    await expect(addToCart(prisma, buyerId, liveA)).rejects.toThrow('이미 구매한');
  });
});

describe('removeFromCart', () => {
  it('담긴 건을 뺀다', async () => {
    await removeFromCart(prisma, buyerId, expiring);
    expect(await countCart(prisma, buyerId)).toBe(0);
  });
});
