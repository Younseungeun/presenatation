import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { createDraftReport, publishReport } from '../reportService';
import { purchaseReport } from '../purchaseService';
import { confirmDelayedBaseBatch } from '../delayedBaseService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';

// 장중 게시 <14일 주식(DAY_CLOSE_AT_CLOSE) — 목표가로만 게시, 게시일 마감 종가로 기준가를
// 확정하고 그때 판매를 연다. 확정 전 구매 불가 · 방향 위반이면 철회.

let prisma: PrismaClient;
let researcherId: string;
let researcherUserId: string;
let buyerId: string;

const TICKER = '005930';
const DRAFT = new Date('2026-07-13T00:00:00Z'); // KST 월 09:00
const PUBLISH = new Date('2026-07-13T01:00:00Z'); // KST 월 10:00 — 장중
const DEADLINE = new Date('2026-07-16T06:30:00Z'); // KST 목 15:30 (+3일)
const AFTER_CLOSE = new Date('2026-07-13T06:35:00Z'); // KST 월 15:35 — 마감 +5분

function kr(close: number, date = '2026-07-13'): ProviderRegistry {
  const p = new FixtureMarketDataProvider().setCurrentPrice(TICKER, close);
  p.setQuotes(TICKER, [{ date, open: close, high: close, low: close, close, volume: 1 }]);
  return { KR_EQUITY: p };
}

async function publishTarget(targetValue: number, direction: 'UP' | 'DOWN' = 'UP') {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: 't',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      prepaymentRatio: 0,
      card: {
        assetClass: 'KR_EQUITY',
        ticker: TICKER,
        assetName: '삼성전자',
        direction,
        targetType: 'TARGET_PRICE',
        targetValue,
        confidence: 5,
        selfStability: 5,
        deadline: DEADLINE,
      },
    },
    DRAFT,
  );
  // 장중 게시 — 기준가 조회 없이 게시된다(basePrice null). registry 비어도 된다.
  await publishReport(prisma, {}, draft.id, researcherId, PUBLISH);
  return draft.id;
}

beforeAll(async () => {
  prisma = createTestDb('delayed-base-');
  await seedTestInstruments(prisma);
  const r = await prisma.user.create({
    data: {
      email: 'r@e.io',
      identityVerified: true,
      researcherProfile: { create: { tier: 'CHALLENGER' } },
    },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  researcherUserId = r.id;
  const b = await prisma.user.create({ data: { email: 'b@e.io', identityVerified: true } });
  buyerId = b.id;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('장중 게시 기준가 마감 확정 (DAY_CLOSE_AT_CLOSE)', () => {
  it('확정 전에는 판매 시작 전 — 구매 불가', async () => {
    const id = await publishTarget(80_000);
    await expect(purchaseReport(prisma, id, buyerId, PUBLISH)).rejects.toThrow(/판매가 시작되지 않/);
    // 확정 후 다른 테스트에 영향 주지 않게 여기서 확정해 둔다
    await confirmDelayedBaseBatch(prisma, kr(70_000), AFTER_CLOSE, 'KR_EQUITY');
  });

  it('마감 종가로 기준가 확정 → 판매 오픈, 구매 가능', async () => {
    const id = await publishTarget(80_000); // 기준가 70,000 → 목표가 80,000 (UP, +14%)
    await confirmDelayedBaseBatch(prisma, kr(70_000), AFTER_CLOSE, 'KR_EQUITY');

    const card = await prisma.predictionCard.findUniqueOrThrow({ where: { reportId: id } });
    expect(card.basePrice).toBe(70_000);
    expect(card.baseConfirmedAt).not.toBeNull();
    expect(card.withdrawnAt).toBeNull();

    // 판매가 열렸다 — 확정 시각 이후로 구매 가능
    const buy = await purchaseReport(prisma, id, buyerId, new Date('2026-07-13T07:00:00Z'));
    expect(buy).toBeTruthy();
  });

  it('확정 기준가와 목표 방향이 어긋나면 철회 + 통지 (판매 전이라 환불 없음)', async () => {
    const id = await publishTarget(60_000); // UP인데 목표가 60,000 < 확정 기준가 70,000
    await confirmDelayedBaseBatch(prisma, kr(70_000), AFTER_CLOSE, 'KR_EQUITY');

    const card = await prisma.predictionCard.findUniqueOrThrow({ where: { reportId: id } });
    expect(card.withdrawnAt).not.toBeNull();
    expect(card.basePrice).toBeNull();

    const notif = await prisma.notification.findFirst({
      where: { userId: researcherUserId, type: 'PUBLISH_INVALIDATED' },
    });
    expect(notif).not.toBeNull();
  });

  it('아직 종가가 없으면 미룬다 (기준가·판매 그대로)', async () => {
    const id = await publishTarget(80_000);
    // 게시일 종가가 없는 registry — 다음 회차로 미룸
    const emptyKr: ProviderRegistry = { KR_EQUITY: new FixtureMarketDataProvider() };
    const res = await confirmDelayedBaseBatch(prisma, emptyKr, AFTER_CLOSE, 'KR_EQUITY');
    expect(res.notYet).toBeGreaterThanOrEqual(1);

    const card = await prisma.predictionCard.findUniqueOrThrow({ where: { reportId: id } });
    expect(card.basePrice).toBeNull();
    expect(card.baseConfirmedAt).toBeNull();
    expect(card.withdrawnAt).toBeNull();
  });
});
