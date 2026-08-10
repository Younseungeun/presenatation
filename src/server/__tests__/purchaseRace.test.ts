import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { purchaseReport } from '../purchaseService';
import { setPriceForTests } from '../priceCache';
import { createDraftReport, publishReport } from '../reportService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';

// 결제 도중에 판매가 마감되는 경우.
//
// purchaseReport는 시작할 때 리포트를 읽어 판단하고, 그 뒤 시세를 조회하느라
// 수백 ms를 쓴다. 그동안 판매 마감 배치가 같은 리포트를 닫을 수 있다.
// 낡은 값으로 판단해 구매를 만들면 마감된 카드가 팔린 것이 된다.
//
// 여기서는 "시세 조회 중에 배치가 끼어든 상황"을 시세 훅 안에서 리포트를 닫아 재현한다.

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;

const DRAFT = new Date('2026-07-01T00:00:00Z');
const PUBLISH = new Date('2026-07-02T00:00:00Z');
const NOW = new Date('2026-07-05T00:00:00Z');
const TICKER = 'KRW-AAA';

function reg() {
  const p = new FixtureMarketDataProvider().setCurrentPrice(TICKER, 100);
  p.setQuotes(TICKER, [
    { date: '2026-07-02', open: 100, high: 100, low: 100, close: 100, volume: 1 },
  ]);
  return { CRYPTO: p } as ProviderRegistry;
}

async function makeReport() {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId, title: 't', summary: 's', content: 'c', priceKrw: 10_000, prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO', ticker: TICKER, assetName: 'AAA', direction: 'UP',
        targetType: 'RETURN_PCT', targetValue: 20, confidence: 5, selfStability: 5,
        deadline: new Date('2026-12-01T00:00:00Z'),
      },
    },
    DRAFT,
  );
  await publishReport(prisma, reg(), draft.id, researcherId, PUBLISH);
  return draft.id;
}

beforeAll(async () => {
  prisma = createTestDb('race-');
  await seedTestInstruments(prisma);
  const r = await prisma.user.create({
    data: { email: 'r@x.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  const b = await prisma.user.create({ data: { email: 'b@x.io', identityVerified: true } });
  buyerId = b.id;
});
afterAll(async () => {
  setPriceForTests(null);
  await prisma.$disconnect();
});

describe('결제 도중 판매 마감', () => {
  it('시세 조회 사이에 마감되면 구매가 만들어지지 않는다', async () => {
    const id = await makeReport();

    // **진짜 틈에서 닫는다.** purchaseReport가 리포트를 읽어 판단을 마친 뒤,
    // 시세를 조회하려고 await하는 바로 그 지점에서 배치가 끼어든 상황을 재현한다.
    setPriceForTests(async () => {
      await prisma.report.update({
        where: { id }, data: { salesClosedAt: NOW, salesCloseReason: 'BAND_EXIT' },
      });
      return 100;
    });

    await expect(purchaseReport(prisma, id, buyerId, NOW)).rejects.toThrow();
    const count = await prisma.purchase.count({ where: { reportId: id } });
    expect(count, '마감된 리포트에 구매가 남으면 안 된다').toBe(0);
  });

  it('정상 상태면 구매가 만들어진다 — 가드가 멀쩡한 결제까지 막지 않는다', async () => {
    const id = await makeReport();
    setPriceForTests(() => null);
    const p = await purchaseReport(prisma, id, buyerId, NOW);
    expect(p.escrowStatus).toBe('HELD');
    expect(await prisma.purchase.count({ where: { reportId: id } })).toBe(1);
  });
});
