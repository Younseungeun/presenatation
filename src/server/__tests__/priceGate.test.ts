import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { setPriceForTests } from '../priceCache';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// **판정은 모르면 멈추는데 판매만 모르면 팔고 있었다.**
//
// 시세를 못 구했을 때 판정은 이월하고(JudgmentDeferredError) 결제 관문은 통과시켰다.
// 시세 소스가 장중에 몇 시간 죽으면 가격 방어(q ≥ 0.5)가 **조용히 꺼진 채로** 계속
// 팔린다 — 급락한 종목의 q<0.5 카드가 그대로 나가고 아무 기록도 남지 않는다.
//
// 이제 갈래가 셋이다:
//  ① 공급자 미설정 → 막고 운영자에게 알린다 (배포 사고지 시장 사건이 아니다)
//  ② 물어봤는데 답이 없다 → 장중이면 막고, 장이 닫혔으면 통과 (닫힌 동안 q는 안 변한다)
//  ③ 장중인데 실시간이 아니라 어제 종가다 → 막는다. 하루치 오차는 q<0.5를 그냥 뒤집는다
//
// 코인은 24시간 열려 있어(isMarketOpen 항상 true) ①②③이 모두 "장중"으로 걸린다.

const alerts: { title: string; dedupeKey?: string }[] = [];
vi.mock('../opsAlert', () => ({
  notifyOperators: vi.fn(async (_p: unknown, a: { title: string; dedupeKey?: string }) => {
    alerts.push(a);
  }),
}));

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;
let reportId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const NOW = new Date('2026-07-20T05:00:00Z');
const TICKER = 'KRW-AAA';

function registry(): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider()
      .setCurrentPrice(TICKER, 100)
      .setQuotes(TICKER, [
        { date: '2026-07-12', open: 100, high: 100, low: 100, close: 100, volume: 1 },
      ]),
  };
}

beforeAll(async () => {
  prisma = createTestDb('price-gate-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@g.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@g.io', identityVerified: true } })).id;

  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: '전망',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker: TICKER,
        assetName: TICKER,
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 20,
        confidence: 5,
        selfStability: 5,
        deadline: new Date('2026-12-01T00:00:00Z'),
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, registry(), draft.id, researcherId, PUBLISH_NOW);
  reportId = draft.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  setPriceForTests(null);
  alerts.length = 0;
  await prisma.purchase.deleteMany({});
});

describe('가격 관문 — 모르면 팔지 않는다', () => {
  it('실시간 시세가 있으면 산다 — 그리고 LIVE로 기록된다', async () => {
    setPriceForTests(() => 105);
    const p = await purchaseReport(prisma, reportId, buyerId, NOW);
    expect(p.priceGate).toBe('LIVE');
  });

  it('장중에 시세를 못 구하면 막는다 — 예전에는 통과시켰다', async () => {
    setPriceForTests(() => null); // 물어봤는데 답이 없다
    await expect(purchaseReport(prisma, reportId, buyerId, NOW)).rejects.toThrow(
      /거래소 시세를 확인할 수 없어/,
    );
    expect(await prisma.purchase.count()).toBe(0);
  });

  it('q < 0.5면 여전히 막는다 — 이 관문의 본업이다', async () => {
    // 기준가 100, 목표 +20% → 120. 지금 115면 남은 폭 5 / 광고 20 = 0.25
    setPriceForTests(() => 115);
    await expect(purchaseReport(prisma, reportId, buyerId, NOW)).rejects.toThrow(
      /남은 폭이 광고한 폭의 절반 밑/,
    );
  });

  it('시세를 꽂지 않은 테스트는 관문을 타지 않는다 — 픽스처 전체가 막히면 안 된다', async () => {
    setPriceForTests(null);
    const p = await purchaseReport(prisma, reportId, buyerId, NOW);
    expect(p.priceGate).toBe('NO_CARD');
  });
});
