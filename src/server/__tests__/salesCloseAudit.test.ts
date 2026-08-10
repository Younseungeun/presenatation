import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { closeSalesByResearcher, runSalesCloseBatch } from '../salesCloseService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { createDraftReport, publishReport } from '../reportService';

// 판매 마감 배치의 실제 동작을 캐본다 — 규칙이 말하는 것과 코드가 하는 것의 차이.

let prisma: PrismaClient;
let researcherId: string;

const DRAFT = new Date('2026-07-01T00:00:00Z');
const PUBLISH = new Date('2026-07-02T00:00:00Z');
const TICKER = 'KRW-AAA';

function provider(quotes: { date: string; close: number }[]) {
  const p = new FixtureMarketDataProvider().setCurrentPrice(TICKER, 100);
  p.setQuotes(
    TICKER,
    quotes.map((q) => ({ date: q.date, open: q.close, high: q.close, low: q.close, close: q.close, volume: 1 })),
  );
  return { CRYPTO: p } as ProviderRegistry;
}

async function makeCard(deadline: Date) {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: 't', summary: 's', content: 'c', priceKrw: 10_000, prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO', ticker: TICKER, assetName: 'AAA', direction: 'UP',
        targetType: 'RETURN_PCT', targetValue: 20, // 기준가 100 → 목표 120, 수익성 구간 2(15%바닥) → 마감선 10%
        confidence: 5, selfStability: 5, deadline,
      },
    },
    DRAFT,
  );
  await publishReport(prisma, provider([{ date: '2026-07-02', close: 100 }]), draft.id, researcherId, PUBLISH);
  return draft.id;
}

beforeAll(async () => {
  prisma = createTestDb('sales-audit-');
  await seedTestInstruments(prisma);
  const u = await prisma.user.create({
    data: { email: 'r@a.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = u.researcherProfile!.id;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('배치가 놓치는 종가', () => {
  it('배치를 거른 사이 마감선을 뚫은 종가가 있어도, 회복하면 마감되지 않는다', async () => {
    // 기준가 100, 목표 +20% → 목표가 120. 수익성 구간 2 → 마감선 = 잔여 10%
    // 잔여 10% = 현재가가 120/1.10 ≈ 109.1 이상이면 마감
    const id = await makeCard(new Date('2026-12-01T00:00:00Z'));
    const now = new Date('2026-07-10T00:00:00Z');

    // 07-08에 115(잔여 4.3% → 마감선 아래, 마감돼야 함) → 07-09에 100으로 회복
    const reg = provider([
      { date: '2026-07-07', close: 100 },
      { date: '2026-07-08', close: 115 }, // ← 이 종가가 규칙상 마감 사유
      { date: '2026-07-09', close: 100 }, // ← 회복
    ]);
    const res = await runSalesCloseBatch(prisma, now, reg);
    const after = await prisma.report.findUniqueOrThrow({ where: { id }, select: { salesClosedAt: true } });

    // 규칙: "잔여가 마감선 밑인 **종가가 찍히면** 마감" → 07-08에 찍혔으므로 마감이어야 한다
    expect(res.checked).toBeGreaterThan(0);
    expect(after.salesClosedAt, '배치가 마지막 종가만 봐서 07-08 이탈을 놓쳤다').not.toBeNull();
  });
});

// 리서처 자발 판매 단축 — 회수 불가가 이 기능의 핵심이라 그것부터 고정한다.
describe('closeSalesByResearcher', () => {
  it('본인이 아니면 막는다', async () => {
    const id = await makeCard(new Date('2026-12-01T00:00:00Z'));
    await expect(
      closeSalesByResearcher(prisma, id, 'someone-else', new Date('2026-07-05T00:00:00Z')),
    ).rejects.toThrow(/본인이 쓴 리포트만/);
  });

  it('판매를 닫고 사유를 RESEARCHER로 남긴다 — 카드는 살아 있다', async () => {
    const id = await makeCard(new Date('2026-12-01T00:00:00Z'));
    const owner = await prisma.researcherProfile.findUniqueOrThrow({ where: { id: researcherId } });
    await closeSalesByResearcher(prisma, id, owner.userId, new Date('2026-07-05T00:00:00Z'));

    const r = await prisma.report.findUniqueOrThrow({
      where: { id },
      include: { predictionCard: { include: { judgment: true } } },
    });
    expect(r.salesClosedAt).not.toBeNull();
    expect(r.salesCloseReason).toBe('RESEARCHER');
    // **판매만 닫힌다** — 카드는 철회되지 않고 시한에 정상 판정된다
    expect(r.predictionCard!.withdrawnAt).toBeNull();
    expect(r.predictionCard!.judgment).toBeNull();
    expect(r.status).toBe('PUBLISHED');
  });

  it('한 번 닫으면 다시 닫을 수 없다 — 재개 경로 자체가 없다', async () => {
    const id = await makeCard(new Date('2026-12-01T00:00:00Z'));
    const owner = await prisma.researcherProfile.findUniqueOrThrow({ where: { id: researcherId } });
    const at = new Date('2026-07-05T00:00:00Z');
    await closeSalesByResearcher(prisma, id, owner.userId, at);
    await expect(closeSalesByResearcher(prisma, id, owner.userId, at)).rejects.toThrow(
      /이미 판매가 마감된/,
    );
  });

  it('리서처에게 마감 사실을 알린다', async () => {
    const id = await makeCard(new Date('2026-12-01T00:00:00Z'));
    const owner = await prisma.researcherProfile.findUniqueOrThrow({ where: { id: researcherId } });
    await closeSalesByResearcher(prisma, id, owner.userId, new Date('2026-07-05T00:00:00Z'));
    const n = await prisma.notification.findFirst({
      where: { userId: owner.userId, type: 'SALES_CLOSED', link: `/report/${id}` },
    });
    expect(n?.body).toMatch(/다시 열 수 없습니다/);
  });
});
