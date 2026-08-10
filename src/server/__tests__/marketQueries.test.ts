import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCardQuery } from '@/domain/cardQuery';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  getBestSellingCards,
  getCardsByAssetClass,
  getRecentJudgments,
  getResearcherConsensus,
  getTopTierCards,
  getSalesClosingSoonCards,
  searchCards,
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
/** 판매 기간(게시+기간/3)은 지났지만 검증 시한은 아직 남은 카드 — 배치가 늦은 상태를 흉내낸다 */
let windowClosed: string;

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
  // 게시 07-12 + 시한 08-20 → 검증기간 39일 → 판매 기간 13일 → 마감선 07-25 (NOW 08-02보다 과거).
  // salesClosedAt은 일부러 비워 둔다 — 배치가 아직 안 돈 상태가 바로 이 테스트의 대상이다
  windowClosed = await publish(goldId, 'KRW-DDD', new Date('2026-08-20T00:00:00Z'));

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
  // 홈 레일은 **판매 마감**이 가까운 순 — 검증 시한이 아니다.
  // 판매는 검증 기간의 1/3에 닫히므로 시한 임박 카드는 이미 살 수 없다.
  // 같은 날 게시된 hot(12/01 시한)·quiet(12/15 시한)은 판매 창도 같은 순서다.
  it('판매 마감 가까운 순 — 자산군 구분 없이, 판매 중인 카드만', async () => {
    const rows = await getSalesClosingSoonCards(prisma, 5, NOW);
    expect(rows.map((r: { reportId: string }) => r.reportId)).toEqual([hot, quiet]);
    expect(rows.map((r: { reportId: string }) => r.reportId)).not.toContain(expired);
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

// 판매 기간이 끝난 카드는 배치(salesClosedAt)를 기다리지 않고 모든 목록에서 빠진다.
//
// windowClosed는 salesClosedAt이 비어 있어 SQL 조건(buyableWhere)을 그대로 통과한다.
// 걸러내는 것은 buyableCards의 계산이고, 이 describe가 그 짝이 유지되는지 지킨다.
describe('판매 기간 종료 카드는 목록에서 빠진다 (배치 지연과 무관)', () => {
  it('자산군별 목록', async () => {
    const rows = await getCardsByAssetClass(prisma, 'CRYPTO', 'DEADLINE', NOW);
    expect(rows.map((r) => r.reportId)).not.toContain(windowClosed);
  });

  it('상위 등급 레일 — 이 카드의 리서처가 최상위 등급인데도 빠진다', async () => {
    const rows = await getTopTierCards(prisma, 5, NOW);
    expect(rows.map((r) => r.reportId)).not.toContain(windowClosed);
  });

  it('홈 "판매 마감 임박" 레일 — 마감선이 가장 이르다고 1번 자리에 오면 안 된다', async () => {
    const rows = await getSalesClosingSoonCards(prisma, 5, NOW);
    expect(rows.map((r) => r.reportId)).not.toContain(windowClosed);
    // 하한이 없던 시절에는 마감선이 이미 지난 이 카드가 정확히 맨 앞에 왔다
    expect(rows[0]?.reportId).not.toBe(windowClosed);
  });

  it('검색 결과', async () => {
    const rows = await searchCards(prisma, parseCardQuery('#코인'), 'DEADLINE', NOW);
    expect(rows.map((r) => r.reportId)).not.toContain(windowClosed);
  });
});

// 예측 히트맵의 표본 경계 — **검증 시한이 기준이지 판매 기한이 아니다.**
// 히트맵은 "지금 검증 중인 예측의 종목별 방향 분포"라, 판매가 끝났어도 예측은
// 살아서 판정을 기다리는 중이므로 계속 세야 한다. 코드는 이미 그렇게 동작하지만
// 지키는 테스트가 없었다 — salesClosedAt 조건이 실수로 끼면 조용히 틀어진다.
describe('예측 히트맵 표본 = 검증 시한 기준', () => {
  it('판매가 마감된 카드도 시한 전이면 계속 센다', async () => {
    const before = await getResearcherConsensus(prisma, 100, NOW);
    const total = (rows: typeof before) => rows.reduce((n, r) => n + r.total, 0);
    const n0 = total(before);

    await prisma.report.update({
      where: { id: quiet },
      data: { salesClosedAt: NOW, salesCloseReason: 'WINDOW_END' },
    });
    const after = await getResearcherConsensus(prisma, 100, NOW);
    expect(total(after), '판매 마감이 히트맵 표본을 줄이면 안 된다').toBe(n0);

    await prisma.report.update({
      where: { id: quiet },
      data: { salesClosedAt: null, salesCloseReason: null },
    });
  });

  it('검증 시한이 지나면 그때부터 세지 않는다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId: quiet } });
    const inWindow = await getResearcherConsensus(prisma, 100, NOW);
    expect(inWindow.some((r) => r.ticker === card.ticker)).toBe(true);

    // 시한 직후를 기준 시각으로 두면 같은 카드가 표본에서 빠진다
    const past = new Date(card.deadline.getTime() + 1000);
    const afterDeadline = await getResearcherConsensus(prisma, 100, past);
    expect(afterDeadline.some((r) => r.ticker === card.ticker)).toBe(false);
  });
});
