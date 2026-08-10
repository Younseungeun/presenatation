import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { runEarlyJudgmentBatch } from '../earlyJudgmentBatch';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { createDraftReport, publishReport } from '../reportService';
import { purchaseReport } from '../purchaseService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';

// 조기 판정 — **결과는 바꾸지 않고 시점만 앞당긴다**는 불변식을 고정한다.

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;

const DRAFT = new Date('2026-07-01T00:00:00Z');
const PUBLISH = new Date('2026-07-02T00:00:00Z');
const DEADLINE = new Date('2026-10-01T00:00:00Z');
const TICKER = 'KRW-AAA';

function reg(rows: { date: string; high: number; low: number; close: number }[]) {
  const p = new FixtureMarketDataProvider().setCurrentPrice(TICKER, 100);
  p.setQuotes(TICKER, rows.map((q) => ({ ...q, open: q.close, volume: 1 })));
  return { CRYPTO: p } as ProviderRegistry;
}
const AT_PUBLISH = [{ date: '2026-07-02', high: 100, low: 100, close: 100 }];

async function publish(targetType: 'TARGET_PRICE' | 'RETURN_PCT', targetValue: number) {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId, title: 't', summary: 's', content: 'c', priceKrw: 10_000, prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO', ticker: TICKER, assetName: 'AAA', direction: 'UP',
        targetType, targetValue, confidence: 5, selfStability: 5, deadline: DEADLINE,
      },
    },
    DRAFT,
  );
  await publishReport(prisma, reg(AT_PUBLISH), draft.id, researcherId, PUBLISH);
  return draft.id;
}

beforeAll(async () => {
  prisma = createTestDb('early-');
  await seedTestInstruments(prisma);
  const r = await prisma.user.create({
    data: { email: 'r@e.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  const b = await prisma.user.create({ data: { email: 'b@e.io', identityVerified: true } });
  buyerId = b.id;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('조기 판정', () => {
  it('목표가에 닿으면 시한 전에 판정·정산된다', async () => {
    const id = await publish('TARGET_PRICE', 130); // 기준가 100 → 목표가 130
    await purchaseReport(prisma, id, buyerId, PUBLISH);

    const touched = reg([
      ...AT_PUBLISH,
      { date: '2026-07-20', high: 135, low: 120, close: 132 }, // 목표 돌파
    ]);
    const s = await runEarlyJudgmentBatch(prisma, touched, new Date('2026-07-21T00:00:00Z'));
    expect(s.judged).toBe(1);

    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId: id }, include: { judgment: true },
    });
    expect(card.judgment?.outcome).toBe('HIT');
    // 시한(10-01)보다 한참 앞선 시점에 판정됐다
    expect(card.judgment!.judgedAt.getTime()).toBeLessThan(DEADLINE.getTime());
    // 에스크로가 실제로 정산됐다 — 판정만 하고 돈이 안 움직이면 반쪽이다
    const purchase = await prisma.purchase.findFirstOrThrow({ where: { reportId: id } });
    expect(purchase.escrowStatus).not.toBe('HELD');
  });

  it('아직 목표에 못 닿았으면 건드리지 않는다 — MISS를 조기 확정하지 않는다', async () => {
    const id = await publish('TARGET_PRICE', 200);
    const s = await runEarlyJudgmentBatch(
      prisma,
      reg([...AT_PUBLISH, { date: '2026-07-20', high: 150, low: 90, close: 140 }]),
      new Date('2026-07-21T00:00:00Z'),
    );
    expect(s.notYet).toBeGreaterThan(0);
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId: id }, include: { judgment: true },
    });
    expect(card.judgment).toBeNull();
  });

  it('수익률형은 조기 판정 대상이 아니다 — 시한 종가로 판정되므로 확정이 아니다', async () => {
    const id = await publish('RETURN_PCT', 20); // 목표 +20% → 120
    const card0 = await prisma.predictionCard.findFirstOrThrow({ where: { reportId: id } });
    expect(card0.earlyJudgment, '수익률형에는 플래그가 켜지지 않는다').toBe(false);

    // 다른 테스트가 남긴 카드도 후보에 섞이므로 배치 집계가 아니라 이 카드로 확인한다
    await runEarlyJudgmentBatch(
      prisma,
      reg([...AT_PUBLISH, { date: '2026-07-20', high: 140, low: 130, close: 135 }]), // +35%
      new Date('2026-07-21T00:00:00Z'),
    );
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId: id }, include: { judgment: true },
    });
    expect(card.judgment).toBeNull();
  });

  it('조기 판정한 결과는 시한까지 기다린 결과와 같다', async () => {
    const early = await publish('TARGET_PRICE', 130);
    const late = await publish('TARGET_PRICE', 130);
    // 늦은 쪽은 조기 판정 대상에서 빼 둔다 (같은 시세로 두 경로를 비교하기 위해)
    await prisma.predictionCard.updateMany({
      where: { reportId: late }, data: { earlyJudgment: false },
    });

    const quotes = reg([
      ...AT_PUBLISH,
      { date: '2026-07-20', high: 135, low: 120, close: 132 },
      { date: '2026-09-30', high: 135, low: 100, close: 105 }, // 되돌아왔지만 목표가형은 HIT 유지
    ]);
    await runEarlyJudgmentBatch(prisma, quotes, new Date('2026-07-21T00:00:00Z'));
    await judgeAndSettleDueCards(prisma, quotes, new Date('2026-10-02T00:00:00Z'));

    const [a, b] = await Promise.all([
      prisma.predictionCard.findFirstOrThrow({ where: { reportId: early }, include: { judgment: true } }),
      prisma.predictionCard.findFirstOrThrow({ where: { reportId: late }, include: { judgment: true } }),
    ]);
    expect(a.judgment?.outcome).toBe('HIT');
    expect(b.judgment?.outcome).toBe(a.judgment?.outcome);
  });
});

// 호출량 — 같은 종목 카드가 여러 장이어도 시세 조회는 종목 수만큼만 나가야 한다.
describe('조기 판정 배치는 종목 단위로 조회한다', () => {
  it('같은 종목 카드 3장 → 시세 조회 1회', async () => {
    await Promise.all([publish('TARGET_PRICE', 500), publish('TARGET_PRICE', 600), publish('TARGET_PRICE', 700)]);

    const inner = new FixtureMarketDataProvider().setCurrentPrice(TICKER, 100);
    inner.setQuotes(TICKER, [{ date: '2026-07-02', open: 100, high: 100, low: 100, close: 100, volume: 1 }]);
    let calls = 0;
    const counting = {
      sourceId: inner.sourceId,
      getDailyQuotes: (t: string, f: string, to: string) => { calls++; return inner.getDailyQuotes(t, f, to); },
      getSecurityStatus: (t: string) => inner.getSecurityStatus(t),
    };

    await runEarlyJudgmentBatch(prisma, { CRYPTO: counting } as ProviderRegistry, new Date('2026-07-21T00:00:00Z'));
    // 후보 카드는 여러 장인데 종목은 하나뿐이다
    expect(calls).toBe(1);
  });
});
