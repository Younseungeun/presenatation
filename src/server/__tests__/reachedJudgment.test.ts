import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { runReachedJudgmentBatch } from '../reachedJudgmentBatch';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { createDraftReport, publishReport } from '../reportService';
import { purchaseReport } from '../purchaseService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';

// 도달 판정 — **결과를 바꾸지 않고 기록 시점만 앞당긴다**는 불변식을 고정한다.
// "조기"가 아니다: 예측("기한 안에 종가로 닿는다")이 이뤄진 날 판정하는 것이다.

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
  prisma = createTestDb('reached-');
  await seedTestInstruments(prisma);
  const r = await prisma.user.create({
    data: {
      email: 'r@e.io',
      identityVerified: true,
      // 활성 카드 상한 회피 — 이 파일은 카드를 여러 장 게시한다
      researcherProfile: { create: { tier: 'CHALLENGER' } },
    },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  const b = await prisma.user.create({ data: { email: 'b@e.io', identityVerified: true } });
  buyerId = b.id;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('도달 판정', () => {
  it('종가가 목표에 닿으면 그날 판정·정산된다 (목표가형)', async () => {
    const id = await publish('TARGET_PRICE', 130); // 기준가 100 → 목표가 130
    await purchaseReport(prisma, id, buyerId, PUBLISH);

    const touched = reg([
      ...AT_PUBLISH,
      { date: '2026-07-20', high: 135, low: 120, close: 132 }, // 종가로 목표 돌파
    ]);
    const s = await runReachedJudgmentBatch(prisma, touched, new Date('2026-07-21T00:00:00Z'));
    expect(s.judged).toBeGreaterThanOrEqual(1);

    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId: id }, include: { judgment: true },
    });
    expect(card.judgment?.outcome).toBe('HIT');
    // 판정가 = 목표가 (초과분 미반영)
    expect(card.judgment?.settledPrice).toBe(130);
    expect(card.judgment!.judgedAt.getTime()).toBeLessThan(DEADLINE.getTime());
    // 에스크로가 실제로 정산됐다 — 판정만 하고 돈이 안 움직이면 반쪽이다
    const purchase = await prisma.purchase.findFirstOrThrow({ where: { reportId: id } });
    expect(purchase.escrowStatus).not.toBe('HELD');
  });

  it('수익률형도 똑같이 도달 판정된다 — 판정 규칙이 하나뿐이다', async () => {
    const id = await publish('RETURN_PCT', 25); // 기준가 100 → 목표 125
    const s = await runReachedJudgmentBatch(
      prisma,
      reg([...AT_PUBLISH, { date: '2026-07-20', high: 140, low: 120, close: 126 }]), // 종가 126 ≥ 125
      new Date('2026-07-21T00:00:00Z'),
    );
    expect(s.judged).toBeGreaterThanOrEqual(1);
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId: id }, include: { judgment: true },
    });
    expect(card.judgment?.outcome).toBe('HIT');
    expect(card.judgment?.settledPrice).toBe(125);
  });

  it('장중 고가만 닿고 종가가 돌아왔으면 판정하지 않는다 — 도달은 종가로만', async () => {
    const id = await publish('TARGET_PRICE', 160);
    await runReachedJudgmentBatch(
      prisma,
      reg([...AT_PUBLISH, { date: '2026-07-20', high: 165, low: 120, close: 140 }]), // 장중만 터치
      new Date('2026-07-21T00:00:00Z'),
    );
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId: id }, include: { judgment: true },
    });
    expect(card.judgment).toBeNull();
  });

  it('아직 못 닿았으면 건드리지 않는다 — 실패를 조기 확정하지 않는다', async () => {
    const id = await publish('TARGET_PRICE', 200);
    await runReachedJudgmentBatch(
      prisma,
      reg([...AT_PUBLISH, { date: '2026-07-20', high: 150, low: 90, close: 140 }]),
      new Date('2026-07-21T00:00:00Z'),
    );
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId: id }, include: { judgment: true },
    });
    expect(card.judgment).toBeNull();
  });

  it('도달 판정한 결과는 기한까지 기다린 결과와 같다 — 점수까지', async () => {
    const early = await publish('TARGET_PRICE', 130);
    const late = await publish('TARGET_PRICE', 130);

    const quotes = reg([
      ...AT_PUBLISH,
      { date: '2026-07-20', high: 135, low: 120, close: 132 }, // 도달
      { date: '2026-09-30', high: 135, low: 100, close: 105 }, // 이후 되돌림
    ]);
    // early를 도달 시점에 판정한 뒤, 남은 late는 기한 배치로 — 같은 시세로 두 경로 비교.
    // (도달 배치는 전 카드 대상이라 late도 함께 판정된다 — 그래서 도달 배치를 한 번만
    //  돌리고, 그 회차에 실제로 두 장 다 판정됐는지 확인한 뒤 결과 동등성만 본다)
    await runReachedJudgmentBatch(prisma, quotes, new Date('2026-07-21T00:00:00Z'));
    await judgeAndSettleDueCards(prisma, quotes, new Date('2026-10-02T00:00:00Z'));

    const [a, b] = await Promise.all([
      prisma.predictionCard.findFirstOrThrow({ where: { reportId: early }, include: { judgment: true } }),
      prisma.predictionCard.findFirstOrThrow({ where: { reportId: late }, include: { judgment: true } }),
    ]);
    expect(a.judgment?.outcome).toBe('HIT');
    expect(b.judgment?.outcome).toBe('HIT');
    expect(a.judgment?.settledPrice).toBe(b.judgment?.settledPrice); // 둘 다 목표가
    expect(a.judgment?.score).toBeCloseTo(b.judgment!.score!, 5);
  });
});

// 호출량 — 같은 종목 카드가 여러 장이어도 시세 조회는 종목 수만큼만 나가야 한다.
describe('도달 판정 배치는 종목 단위로 조회한다', () => {
  it('같은 종목 후보가 여럿 → 시세 조회 1회', async () => {
    await Promise.all([publish('TARGET_PRICE', 500), publish('TARGET_PRICE', 600)]);

    const inner = new FixtureMarketDataProvider().setCurrentPrice(TICKER, 100);
    inner.setQuotes(TICKER, [
      { date: '2026-07-02', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ]);
    let calls = 0;
    const counting = {
      sourceId: inner.sourceId,
      getDailyQuotes: (t: string, f: string, to: string) => {
        calls++;
        return inner.getDailyQuotes(t, f, to);
      },
      getSecurityStatus: (t: string) => inner.getSecurityStatus(t),
    };

    await runReachedJudgmentBatch(
      prisma,
      { CRYPTO: counting } as ProviderRegistry,
      new Date('2026-07-21T00:00:00Z'),
    );
    expect(calls).toBe(1);
  });
});
