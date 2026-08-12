import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { createDraftReport, publishReport } from '../reportService';
import { rebaseIfAdjusted } from '../corporateActionService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';

// 액면분할 반영 — 앵커(게시일 종가)가 달라졌으면 그 배수로 카드를 옮긴다.
// 여기서 확인하는 것은 배선이다: 게시가 앵커를 남기는가, 배치가 그걸로 고치는가,
// 고친 사실이 감사 기록에 남는가.

const TICKER = 'KRW-AAA';
const DRAFT = new Date('2026-07-01T00:00:00Z');
const PUBLISH = new Date('2026-07-02T00:00:00Z');
const DEADLINE = new Date('2026-10-01T00:00:00Z');

let prisma: PrismaClient;
let researcherId: string;

/** 게시일 종가 100 — 앵커가 이 값으로 남는다 */
function registry(): ProviderRegistry {
  const p = new FixtureMarketDataProvider().setCurrentPrice(TICKER, 100);
  p.setQuotes(TICKER, [
    { date: '2026-07-02', open: 100, high: 100, low: 100, close: 100, volume: 1 },
  ]);
  return { CRYPTO: p };
}

/** 분할 후 세계 — 같은 날짜의 종가가 절반으로 다시 쓰였다 */
function splitRegistry(): ProviderRegistry {
  const p = new FixtureMarketDataProvider().setCurrentPrice(TICKER, 50);
  p.setQuotes(TICKER, [
    { date: '2026-07-02', open: 50, high: 50, low: 50, close: 50, volume: 1 },
  ]);
  return { CRYPTO: p };
}

async function publish(targetType: 'TARGET_PRICE' | 'RETURN_PCT', targetValue: number) {
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
        assetClass: 'CRYPTO',
        ticker: TICKER,
        assetName: 'AAA',
        direction: 'UP',
        targetType,
        targetValue,
        confidence: 5,
        selfStability: 5,
        deadline: DEADLINE,
      },
    },
    DRAFT,
  );
  await publishReport(prisma, registry(), draft.id, researcherId, PUBLISH);
  return prisma.predictionCard.findFirstOrThrow({ where: { reportId: draft.id } });
}

beforeAll(async () => {
  prisma = createTestDb('corpaction-');
  await seedTestInstruments(prisma);
  const user = await prisma.user.create({
    data: {
      email: 'ca@e.io',
      identityVerified: true,
      researcherProfile: { create: { tier: 'CHALLENGER' } },
    },
    include: { researcherProfile: true },
  });
  researcherId = user.researcherProfile!.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('게시가 앵커를 남긴다', () => {
  it('기준가와 함께 그 거래일의 종가·날짜가 저장된다', async () => {
    const card = await publish('TARGET_PRICE', 130);
    expect(card.baseCloseAnchor).toBe(100);
    expect(card.baseCloseAnchorDate).toBe('2026-07-02');
  });
});

describe('분할이 나면 카드를 새 눈금으로 옮긴다', () => {
  it('목표가형: 기준가·목표가가 함께 절반이 된다 (예측 난이도는 그대로)', async () => {
    const card = await publish('TARGET_PRICE', 130);
    const before = card.targetValue / card.basePrice!;

    const out = await rebaseIfAdjusted(prisma, splitRegistry(), card, new Date('2026-07-20T00:00:00Z'));
    expect(out?.applied).toBe(true);
    expect(out?.factor).toBeCloseTo(0.5, 10);

    const after = await prisma.predictionCard.findFirstOrThrow({ where: { id: card.id } });
    expect(after.basePrice).toBeCloseTo(card.basePrice! * 0.5, 10);
    expect(after.targetValue).toBeCloseTo(65, 10);
    expect(after.targetValue / after.basePrice!).toBeCloseTo(before, 10);
  });

  it('수익률형: 목표(%)는 그대로 — 비율은 눈금이 바뀌어도 참이다', async () => {
    const card = await publish('RETURN_PCT', 30);
    await rebaseIfAdjusted(prisma, splitRegistry(), card, new Date('2026-07-20T00:00:00Z'));

    const after = await prisma.predictionCard.findFirstOrThrow({ where: { id: card.id } });
    expect(after.targetValue).toBe(30);
    expect(after.basePrice).toBeCloseTo(card.basePrice! * 0.5, 10);
  });

  it('고친 사실이 감사 기록에 남는다 — 이미 팔린 상품의 조건이 바뀐 것이다', async () => {
    const card = await publish('TARGET_PRICE', 130);
    await rebaseIfAdjusted(prisma, splitRegistry(), card, new Date('2026-07-20T00:00:00Z'));

    const log = await prisma.corporateActionLog.findFirstOrThrow({
      where: { predictionCardId: card.id },
    });
    expect(log.factor).toBeCloseTo(0.5, 10);
    expect(log.anchorBefore).toBe(100);
    expect(log.anchorAfter).toBe(50);
    expect(log.applied).toBe(true);
  });

  it('앵커도 새 눈금으로 옮겨져 같은 사건을 두 번 잡지 않는다', async () => {
    const card = await publish('TARGET_PRICE', 130);
    const reg = splitRegistry();
    await rebaseIfAdjusted(prisma, reg, card, new Date('2026-07-20T00:00:00Z'));

    const after = await prisma.predictionCard.findFirstOrThrow({ where: { id: card.id } });
    expect(after.baseCloseAnchor).toBe(50);
    // 같은 상태로 다시 돌려도 사건이 없다
    expect(await rebaseIfAdjusted(prisma, reg, after, new Date('2026-07-21T00:00:00Z'))).toBeNull();
  });
});

describe('사건이 없으면 아무것도 하지 않는다', () => {
  it('종가가 그대로면 null (기록도 남기지 않는다)', async () => {
    const card = await publish('TARGET_PRICE', 130);
    expect(await rebaseIfAdjusted(prisma, registry(), card, new Date('2026-07-20T00:00:00Z'))).toBeNull();
    expect(
      await prisma.corporateActionLog.count({ where: { predictionCardId: card.id } }),
    ).toBe(0);
  });

  it('앵커가 없는 카드(레거시)는 조회조차 하지 않는다', async () => {
    const card = await publish('TARGET_PRICE', 130);
    const noAnchor = { ...card, baseCloseAnchor: null, baseCloseAnchorDate: null };
    let called = false;
    const spy = {
      CRYPTO: {
        sourceId: 'spy',
        getDailyQuotes: async () => {
          called = true;
          return [];
        },
        getSecurityStatus: async () => ({ delisted: false, halted: false }),
      },
    } as unknown as ProviderRegistry;
    expect(await rebaseIfAdjusted(prisma, spy, noAnchor, new Date())).toBeNull();
    expect(called).toBe(false);
  });
});
