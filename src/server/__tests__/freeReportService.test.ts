import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { addToCart } from '../cartService';
import { createFreeReport, FreeReportError, getFreeReports } from '../freeReportService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { getResearcherConsensus } from '../marketQueries';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// 무료 리포트: 예측 카드 없는 글 → 결제·장바구니·판정 대상이 아니다

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;
let freeId: string;
let paidId: string;

const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const NOW = new Date('2026-08-02T00:00:00Z');

function registry(ticker: string): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
      { date: '2026-07-12', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ]),
  };
}

beforeAll(async () => {
  prisma = createTestDb('free-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@free.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@free.io', identityVerified: true } })).id;

  const free = await createFreeReport(
    prisma,
    {
      researcherId,
      title: '8월 첫째 주 코인 시황',
      summary: '주요 코인 등락과 수급 정리',
      content: '본문',
    },
    PUBLISH_NOW,
  );
  freeId = free.id;

  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: '비트코인 전망',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
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
        selfProfitability: 5,
        deadline: new Date('2026-12-01T00:00:00Z'),
      },
    },
    new Date('2026-07-11T00:00:00Z'),
  );
  await publishReport(prisma, registry('KRW-AAA'), draft.id, researcherId, PUBLISH_NOW);
  paidId = draft.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('createFreeReport', () => {
  it('예측 카드 없이 바로 게시되고 가격·수수료가 0이다', async () => {
    const r = await prisma.report.findUniqueOrThrow({
      where: { id: freeId },
      include: { predictionCard: true },
    });
    expect(r.status).toBe('PUBLISHED');
    expect(r.priceKrw).toBe(0);
    expect(r.feeRateBp).toBe(0);
    expect(r.predictionCard).toBeNull();
  });

  it('제목·본문이 비면 거부한다', async () => {
    await expect(
      createFreeReport(prisma, { researcherId, title: '  ', summary: 's', content: 'c' }),
    ).rejects.toThrow(FreeReportError);
    await expect(
      createFreeReport(prisma, { researcherId, title: 't', summary: 's', content: '' }),
    ).rejects.toThrow(FreeReportError);
  });
});

describe('무료 리포트는 돈 흐름을 타지 않는다', () => {
  it('결제·장바구니 담기가 모두 막힌다', async () => {
    await expect(purchaseReport(prisma, freeId, buyerId, PUBLISH_NOW)).rejects.toThrow(
      '무료 리포트',
    );
    await expect(addToCart(prisma, buyerId, freeId)).rejects.toThrow('무료 리포트');
  });

  it('컨센서스 집계에 영향을 주지 않는다 (카드가 없으므로)', async () => {
    const rows = await getResearcherConsensus(prisma, 5, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].up).toBe(1);
    expect(rows[0].down).toBe(0);
    expect(rows[0].lean).toBe('UP');
  });
});

describe('getFreeReports', () => {
  it('무료 글만 최신순으로 준다 (유료 리포트 제외)', async () => {
    const rows = await getFreeReports(prisma, 5);
    expect(rows.map((r) => r.reportId)).toEqual([freeId]);
    expect(rows.map((r) => r.reportId)).not.toContain(paidId);
    expect(rows[0].title).toBe('8월 첫째 주 코인 시황');
  });
});
