import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { getBuyerPurchases, getResearcherFinance } from '../financeQueries';
import {
  getAllTimeRanking,
  getJudgedInstruments,
  getLeaderboard,
} from '../leaderboardQueries';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// 구매 내역·정산 집계가 실제 돈 흐름(게시→구매→판정→정산)과 일치하는지 검증

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');

function registryFor(ticker: string, closeAtDeadline: number): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
      { date: '2026-07-20', open: 100, high: 105, low: 95, close: 100, volume: 1 },
      {
        date: '2026-08-01',
        open: closeAtDeadline,
        high: Math.max(closeAtDeadline, 100),
        low: Math.min(closeAtDeadline, 100),
        close: closeAtDeadline,
        volume: 1,
      },
    ]),
  };
}

async function publishAndBuy(ticker: string, deadline: Date) {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: `${ticker} 전망`,
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
        targetValue: 10,
        confidence: 5,
        selfStability: 5,
        deadline,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, registryFor(ticker, 100), draft.id, researcherId, PUBLISH_NOW);
  await purchaseReport(prisma, draft.id, buyerId, PUBLISH_NOW);
  return draft.id;
}

beforeAll(async () => {
  prisma = createTestDb('finance-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@f.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@f.io', identityVerified: true } })).id;

  const due = new Date('2026-08-01T00:00:00Z');
  await publishAndBuy('KRW-AAA', due); // HIT 예정 (+12%)
  await publishAndBuy('KRW-BBB', due); // MISS 예정 (-5%)
  await publishAndBuy('KRW-CCC', new Date('2026-12-01T00:00:00Z')); // 미판정 (에스크로 유지)

  await judgeAndSettleDueCards(prisma, registryFor('KRW-AAA', 112), BATCH_NOW);
  await judgeAndSettleDueCards(prisma, registryFor('KRW-BBB', 95), BATCH_NOW);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getBuyerPurchases — 구매 내역', () => {
  it('판정·정산 상태를 포함해 전 구매를 반환', async () => {
    const purchases = await getBuyerPurchases(prisma, buyerId);
    expect(purchases).toHaveLength(3);

    const byTicker = Object.fromEntries(
      purchases.map((p) => [p.report.predictionCard!.ticker, p]),
    );
    // HIT: 환불 없음, 정산 완료
    expect(byTicker['KRW-AAA'].settlement!.buyerRefundKrw).toBe(0);
    expect(byTicker['KRW-AAA'].report.predictionCard!.judgment!.outcome).toBe('HIT');
    // MISS: 전액 현금 환불
    expect(byTicker['KRW-BBB'].settlement!.buyerRefundKrw).toBe(10_000);
    expect(byTicker['KRW-BBB'].escrowStatus).toBe('REFUNDED');
    // 미판정: 에스크로 보관
    expect(byTicker['KRW-CCC'].settlement).toBeNull();
    expect(byTicker['KRW-CCC'].escrowStatus).toBe('HELD');
  });
});

describe('getLeaderboard — 판정 기반 집계', () => {
  it('판정된 자산군만 집계: HIT +495.0, MISS −15.0 → 시즌 점수 +480.0', async () => {
    const rows = await getLeaderboard(prisma, 'CRYPTO', BATCH_NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].researcherId).toBe(researcherId);
    expect(rows[0].sampleSize).toBe(2);
    // v4: HIT +495.0 (p₀ 공제), MISS −15.0 — judgmentBatch.test와 같은 카드 사양
    expect(rows[0].seasonScore).toBeCloseTo(480, 0);

    // 판정 없는 자산군은 빈 리더보드
    expect(await getLeaderboard(prisma, 'KR_EQUITY', BATCH_NOW)).toEqual([]);
  });
});

describe('종목별 리더보드', () => {
  it('판정 이력이 있는 종목만 나열한다 (미판정 종목 제외)', async () => {
    const list = await getJudgedInstruments(prisma, 'CRYPTO');
    expect(list.map((i) => i.ticker).sort()).toEqual(['KRW-AAA', 'KRW-BBB']);
    expect(list.every((i) => i.judgedCount === 1)).toBe(true);
    // 미판정(KRW-CCC)은 제외, 판정 없는 자산군은 빈 목록
    expect(await getJudgedInstruments(prisma, 'KR_EQUITY')).toEqual([]);
  });

  it('ticker를 주면 그 종목 판정만으로 집계한다', async () => {
    const hitOnly = await getLeaderboard(prisma, 'CRYPTO', BATCH_NOW, 'KRW-AAA');
    expect(hitOnly).toHaveLength(1);
    expect(hitOnly[0].sampleSize).toBe(1);
    expect(hitOnly[0].hitRate).toBe(1);
    expect(hitOnly[0].seasonScore).toBeCloseTo(495, 0); // HIT 건만

    const missOnly = await getLeaderboard(prisma, 'CRYPTO', BATCH_NOW, 'KRW-BBB');
    expect(missOnly[0].sampleSize).toBe(1);
    expect(missOnly[0].hitRate).toBe(0);
    expect(missOnly[0].seasonScore).toBeCloseTo(-15, 0); // MISS 건만

    // 판정 없는 종목은 빈 리더보드
    expect(await getLeaderboard(prisma, 'CRYPTO', BATCH_NOW, 'KRW-CCC')).toEqual([]);
  });
});

describe('getAllTimeRanking — 전 기간·전 자산군 통합 랭킹', () => {
  it('자산군 구분 없이 누적 점수를 합산하고 정렬 기준을 바꿀 수 있다', async () => {
    const byScore = await getAllTimeRanking(prisma, 'SCORE', BATCH_NOW);
    expect(byScore).toHaveLength(1);
    expect(byScore[0].researcherId).toBe(researcherId);
    // 시즌 필터가 없을 뿐 같은 판정 2건이므로 리더보드 시즌 점수와 동일
    expect(byScore[0].totalScore).toBeCloseTo(480, 0);
    expect(byScore[0].sampleSize).toBe(2);
    expect(byScore[0].hitRate).toBe(0.5);

    // 정렬 기준만 바뀌고 집계값은 같다
    const byHitRate = await getAllTimeRanking(prisma, 'HIT_RATE', BATCH_NOW);
    expect(byHitRate[0].hitRate).toBe(0.5);
    expect(byHitRate[0].totalScore).toBeCloseTo(480, 0);
  });
});

describe('getResearcherFinance — 정산 집계', () => {
  it('총계: 판매 3건, 보관 10,000, 정산 8,000(HIT 수수료 20% 차감), 환불 10,000', async () => {
    const { totals, byReport } = await getResearcherFinance(prisma, researcherId);
    expect(totals.salesCount).toBe(3);
    expect(totals.heldKrw).toBe(10_000); // 미판정 1건
    expect(totals.payoutKrw).toBe(8_000); // HIT 1건: 10,000 − 20%
    expect(totals.refundedKrw).toBe(10_000); // MISS 1건 전액

    // 리포트별 분해도 총계와 일치 (금액 보존)
    const sum = byReport.reduce(
      (a, r) => a + r.heldKrw + r.payoutKrw + r.refundedKrw,
      0,
    );
    expect(sum).toBe(totals.heldKrw + totals.payoutKrw + totals.refundedKrw);
  });
});
