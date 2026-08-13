import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { JUDGE_BATCH_SIZE, judgeAndSettleDueCards } from '../judgmentBatch';
import { createDraftReport, publishReport } from '../reportService';

// **판정 배치는 한 회차 JUDGE_BATCH_SIZE장으로 끊는다.**
//
// KIS 호출 간격이 1.1초라 분기말처럼 시한이 몰린 날 수백 장을 한 회차에 처리하면
// 큐 뒤의 다른 배치가 통째로 밀리고, 토큰 만료·재시작이 끼면 그 회차가 날아간다.
//
// 끊는 순간 **이월 카드가 앞자리를 영구히 막는 함정**이 생긴다: 이월은 Judgment 행을
// 만들지 않아 다음 조회에도 그대로 잡히므로, 커서 없이 take만 쓰면 매 회차 같은 20장을
// 다시 가져오고 그 뒤 카드는 영원히 판정되지 않는다. 그래서 커서로 앞으로 나아간다.

let prisma: PrismaClient;
/** 자산군별 동시 활성 카드 상한(최상위 등급 15장)에 걸리지 않게 여럿에 나눠 찍는다 */
const researcherIds: string[] = [];

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');

/** 시세가 아예 없는 공급자 — 모든 카드가 **이월**된다 (판정도 실패도 아님) */
const noQuotes: ProviderRegistry = { CRYPTO: new FixtureMarketDataProvider() };

/** 목표 미달 종가를 주는 공급자 — 실제로 판정(MISS)된다 */
function withQuotes(tickers: string[]): ProviderRegistry {
  const p = new FixtureMarketDataProvider();
  for (const t of tickers) {
    p.setCurrentPrice(t, 100).setQuotes(t, [
      { date: '2026-07-20', open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { date: '2026-08-01', open: 95, high: 95, low: 95, close: 95, volume: 1 },
    ]);
  }
  return { CRYPTO: p };
}

async function publishCard(ticker: string, researcherId: string) {
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
        targetValue: 20,
        confidence: 5,
        selfStability: 5,
        deadline: DEADLINE,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, withQuotes([ticker]), draft.id, researcherId, PUBLISH_NOW);
  return draft.id;
}

const TOTAL = JUDGE_BATCH_SIZE + 5; // 한 회차로는 안 끝나는 양
const TICKERS = Array.from({ length: TOTAL }, (_, i) => `KRW-CH${i}`);

beforeAll(async () => {
  prisma = createTestDb('judge-chunk-');
  await seedTestInstruments(
    prisma,
    TICKERS.map((ticker) => ({ assetClass: 'CRYPTO', ticker, name: ticker, shortable: true })),
  );
  // 상한이 넉넉한 등급 + 여럿에 분산 — 이 시험의 대상은 게시 상한이 아니라 배치 청킹이다
  for (const n of [1, 2, 3]) {
    const u = await prisma.user.create({
      data: {
        email: `r${n}@chunk.io`,
        identityVerified: true,
        researcherProfile: { create: { tier: 'CHALLENGER' } },
      },
      include: { researcherProfile: true },
    });
    researcherIds.push(u.researcherProfile!.id);
  }
  for (const [i, t] of TICKERS.entries()) {
    await publishCard(t, researcherIds[i % researcherIds.length]);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('판정 배치 청킹', () => {
  it(`한 회차는 ${JUDGE_BATCH_SIZE}장까지만 손대고 더 있다고 알린다`, async () => {
    const first = await judgeAndSettleDueCards(prisma, noQuotes, BATCH_NOW);
    expect(first.deferred).toBe(JUDGE_BATCH_SIZE);
    expect(first.judged).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.lastId).not.toBeNull();
  });

  it('**커서가 이월 카드를 넘어간다** — 없으면 뒤의 카드가 영원히 판정되지 않는다', async () => {
    // 앞의 20장은 시세가 없어 계속 이월된다(Judgment가 안 생겨 매번 다시 잡힌다).
    // 커서 없이 돌면 두 번째 회차도 같은 20장을 가져와 뒤의 5장에 절대 닿지 못한다
    const first = await judgeAndSettleDueCards(prisma, noQuotes, BATCH_NOW);
    expect(first.judged).toBe(0);

    // 뒤에 남은 카드에는 시세가 있다 → 커서가 제대로 넘어갔다면 판정된다
    const rest = TICKERS.slice(JUDGE_BATCH_SIZE);
    const second = await judgeAndSettleDueCards(
      prisma,
      withQuotes(rest),
      BATCH_NOW,
      undefined,
      first.lastId!,
    );
    expect(second.judged).toBe(rest.length);
    expect(second.hasMore).toBe(false);

    // 실제로 정산까지 끝났는지 — 개수만 세면 "돌긴 돌았다"에 속을 수 있다
    const judged = await prisma.judgment.count();
    expect(judged).toBe(rest.length);
  });
});
