import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  getBestSellingCards,
  getCardsByAssetClass,
  getRecentJudgments,
  getTopTierCards,
  getUpcomingDeadlineCards,
} from '../marketQueries';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// 리더보드(카드 탐색) 조회: 구매 가능 카드만 / 판매량·등급 정렬 / 자산군 필터

let prisma: PrismaClient;
let bronzeId: string;
let goldId: string;
let hot: string;
let quiet: string;
let expired: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const NOW = new Date('2026-08-02T00:00:00Z');

function registry(ticker: string): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
      { date: '2026-07-12', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ]),
  };
}

async function publish(researcherId: string, ticker: string, deadline: Date) {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: `${ticker} 카드`,
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
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
  prisma = createTestDb('market-');
  await seedTestInstruments(prisma);

  const bronze = await prisma.user.create({
    data: { email: 'bronze@m.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  bronzeId = bronze.researcherProfile!.id;

  const gold = await prisma.user.create({
    data: {
      email: 'gold@m.io',
      identityVerified: true,
      researcherProfile: { create: { tier: 'GOLD' } },
    },
    include: { researcherProfile: true },
  });
  goldId = gold.researcherProfile!.id;

  const buyer = await prisma.user.create({
    data: { email: 'b@m.io', identityVerified: true },
  });

  hot = await publish(bronzeId, 'KRW-AAA', new Date('2026-12-01T00:00:00Z'));
  quiet = await publish(goldId, 'KRW-BBB', new Date('2026-12-15T00:00:00Z'));
  expired = await publish(bronzeId, 'KRW-CCC', new Date('2026-08-01T00:00:00Z'));

  await purchaseReport(prisma, hot, buyer.id, PUBLISH_NOW);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getBestSellingCards', () => {
  it('판매 실적이 있는 카드만 판매량 순으로 준다', async () => {
    const rows = await getBestSellingCards(prisma, 5, NOW);
    expect(rows.map((r) => r.reportId)).toEqual([hot]);
    expect(rows[0].salesCount).toBe(1);
  });
});

describe('getTopTierCards', () => {
  it('등급 높은 리서처의 카드가 앞에 온다', async () => {
    const rows = await getTopTierCards(prisma, 5, NOW);
    expect(rows[0].reportId).toBe(quiet);
    expect(rows[0].tier).toBe('GOLD');
    // 시한 지난 카드는 어디에도 나오지 않는다
    expect(rows.map((r) => r.reportId)).not.toContain(expired);
  });
});

describe('getCardsByAssetClass', () => {
  it('시한이 남은 카드만, 마감 임박 순으로 준다', async () => {
    const rows = await getCardsByAssetClass(prisma, 'CRYPTO', 'DEADLINE', NOW);
    expect(rows.map((r) => r.reportId)).toEqual([hot, quiet]); // 12/1 → 12/15
    expect(rows.map((r) => r.reportId)).not.toContain(expired);
  });

  it('인기순은 판매량 내림차순', async () => {
    const rows = await getCardsByAssetClass(prisma, 'CRYPTO', 'POPULAR', NOW);
    expect(rows[0].reportId).toBe(hot);
  });

  it('가격 오름/내림, 등급순 정렬', async () => {
    // hot(브론즈, 10,000) / quiet(골드, 30,000)
    await prisma.report.update({ where: { id: quiet }, data: { priceKrw: 30_000 } });

    const asc = await getCardsByAssetClass(prisma, 'CRYPTO', 'PRICE_ASC', NOW);
    expect(asc.map((r) => r.priceKrw)).toEqual([10_000, 30_000]);

    const desc = await getCardsByAssetClass(prisma, 'CRYPTO', 'PRICE_DESC', NOW);
    expect(desc.map((r) => r.priceKrw)).toEqual([30_000, 10_000]);

    const byTier = await getCardsByAssetClass(prisma, 'CRYPTO', 'TIER', NOW);
    expect(byTier[0].tier).toBe('GOLD');
  });

  it('판정 대상 자산군이 없으면 빈 목록', async () => {
    expect(await getCardsByAssetClass(prisma, 'KR_EQUITY', 'DEADLINE', NOW)).toEqual([]);
  });
});

describe('홈 화면 조회', () => {
  it('마감 임박은 자산군 구분 없이 시한 가까운 순', async () => {
    const rows = await getUpcomingDeadlineCards(prisma, 5, NOW);
    expect(rows.map((r) => r.reportId)).toEqual([hot, quiet]);
    expect(rows.map((r) => r.reportId)).not.toContain(expired);
  });

  it('판정 피드는 최근 판정 순 — 판정 전 카드는 나오지 않는다', async () => {
    const before = await getRecentJudgments(prisma, 6);
    expect(before).toEqual([]);

    // 시한 지난 카드를 판정 처리하면 피드에 뜬다
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId: expired } });
    await prisma.judgment.create({
      data: {
        predictionCardId: card.id,
        outcome: 'HIT',
        realizedReturnPct: 12.5,
        judgedAt: new Date('2026-08-01T00:00:00Z'),
        settledPrice: 112.5,
      },
    });

    const feed = await getRecentJudgments(prisma, 6);
    expect(feed).toHaveLength(1);
    expect(feed[0].reportId).toBe(expired);
    expect(feed[0].outcome).toBe('HIT');
    expect(feed[0].realizedReturnPct).toBe(12.5);
    // 종목명은 게시 시 종목 마스터 기준으로 정규화된다(입력값이 아니라 마스터의 이름)
    expect(feed[0].assetName).toBe('CCC');
  });
});
