import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  addToCart,
  BLOCKED_BY_SIBLING,
  checkoutCart,
  countCart,
  getCart,
  MAX_CART_ITEMS,
  removeFromCart,
} from '../cartService';
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

async function publish(
  ticker: string,
  deadline: Date,
  priceKrw = 10_000,
  opts: { seedInstrument?: boolean; researcherId?: string } = {},
) {
  if (opts.seedInstrument) {
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker, name: ticker, shortable: true },
    ]);
  }
  const seller = opts.researcherId ?? researcherId;
  const draft = await createDraftReport(
    prisma,
    {
      researcherId: seller,
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
  await publishReport(prisma, registry(ticker), draft.id, seller, PUBLISH_NOW);
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

// **일괄 결제는 전부 사거나 아무것도 사지 않는다.**
//
// 예전에는 건별로 성공/실패를 돌려주고 실패 건만 장바구니에 남겼다. 실PG를 붙이면
// 그 방식이 성립하지 않는다 — 결제창은 담긴 것의 **합산 금액을 한 번에 승인**하므로,
// 3건 30,000원을 승인해 놓고 2번째에서 막히면 돈은 다 냈는데 1건만 받는다.
describe('checkoutCart — 일괄 결제', () => {
  it('한 건이라도 막히면 아무것도 사지 않는다 — 나머지도 사유와 함께 돌아온다', async () => {
    const result = await checkoutCart(prisma, buyerId, new Date('2026-08-02T00:00:00Z'));

    expect(result.purchased).toEqual([]);
    // 시한 지난 건 + 그것 때문에 함께 접힌 건들
    expect(result.failed.map((f) => f.reportId).sort()).toEqual([liveA, liveB, expiring].sort());
    expect(result.failed.find((f) => f.reportId === expiring)!.reason).toContain('검증 시한');
    expect(result.failed.find((f) => f.reportId === liveA)!.reason).toBe(BLOCKED_BY_SIBLING);

    // 구매도 없고 장바구니도 그대로다
    expect(await prisma.purchase.count({ where: { buyerId } })).toBe(0);
    expect(await countCart(prisma, buyerId)).toBe(3);
  });

  it('막는 건을 빼면 나머지가 한 트랜잭션으로 전부 구매된다', async () => {
    await removeFromCart(prisma, buyerId, expiring);
    const result = await checkoutCart(prisma, buyerId, new Date('2026-08-02T00:00:00Z'));

    expect(result.purchased.sort()).toEqual([liveA, liveB].sort());
    expect(result.failed).toEqual([]);

    // 구매는 에스크로 보관 상태로 생성된다
    const purchases = await prisma.purchase.findMany({ where: { buyerId } });
    expect(purchases).toHaveLength(2);
    expect(purchases.every((p) => p.escrowStatus === 'HELD')).toBe(true);
    expect(purchases.reduce((a, p) => a + p.amountKrw, 0)).toBe(25_000);
    // 결제 수단이 기록된다 (미지정 시 CARD 기본값 + 모의 마스킹 정보)
    expect(purchases.every((p) => p.paymentMethod === 'CARD')).toBe(true);
    expect(purchases.every((p) => p.paymentInfo && p.paymentInfo.includes('모의'))).toBe(true);

    expect(await countCart(prisma, buyerId)).toBe(0);
  });

  it('이미 구매한 리포트를 다시 담으면 담기 단계에서 막힌다', async () => {
    await expect(addToCart(prisma, buyerId, liveA)).rejects.toThrow('이미 구매한');
  });

  // 결제 한 번에 담긴 것 전부의 시세를 조회하고 그만큼을 한 트랜잭션에 묶으므로,
  // 개수가 늘수록 조회 시간·잠금 구간과 **하나라도 걸릴 확률**이 같이 올라간다.
  // 많이 담은 사람일수록 결제가 안 되는 역설을 상한으로 끊는다
  it(`카드지갑은 ${MAX_CART_ITEMS}건까지만 담긴다 — 담을수록 결제가 어려워지지 않게`, async () => {
    const other = await prisma.user.create({
      data: { email: 'cap@cart.io', identityVerified: true },
    });
    // 동시 게시 상한(등급·자산군별 15건)에 걸리지 않게 최상위 등급 리서처 둘에 나눠 찍고
    // 90일 안쪽 시한을 쓴다 — 이 시험의 대상은 게시 상한이 아니라 카드지갑 상한이다
    const sellers: string[] = [];
    for (const n of [1, 2]) {
      const u = await prisma.user.create({
        data: {
          email: `cap-seller${n}@cart.io`,
          identityVerified: true,
          researcherProfile: { create: { tier: 'CHALLENGER' } },
        },
        include: { researcherProfile: true },
      });
      sellers.push(u.researcherProfile!.id);
    }
    const ids: string[] = [];
    for (let i = 0; i < MAX_CART_ITEMS + 1; i++) {
      ids.push(
        await publish(`KRW-CAP${i}`, new Date('2026-09-15T00:00:00Z'), 10_000, {
          seedInstrument: true,
          researcherId: sellers[i % sellers.length],
        }),
      );
    }
    for (let i = 0; i < MAX_CART_ITEMS; i++) {
      await addToCart(prisma, other.id, ids[i]);
    }
    // 이미 담긴 것을 다시 담는 건 개수를 늘리지 않으므로 상한에 걸리지 않는다
    await expect(addToCart(prisma, other.id, ids[0])).resolves.toBeDefined();
    await expect(addToCart(prisma, other.id, ids[MAX_CART_ITEMS])).rejects.toThrow(
      new RegExp(`최대 ${MAX_CART_ITEMS}건`),
    );
  });
});
