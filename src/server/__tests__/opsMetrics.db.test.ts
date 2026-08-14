import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { getOpsMetrics } from '../opsMetrics';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// **인프라가 초록이어도 서비스는 조용히 죽을 수 있다.**
// 카드가 안 팔리고, 판정이 오래 걸리고, 환불받은 사람이 다시 안 오면
// 시스템은 완벽하게 동작하면서 망한다. 이 지표들이 보는 것은 그쪽이다.
//
// 표본이 작은 초기 구간 전용이라 **분모를 반드시 함께 싣는지**를 시험이 고정한다 —
// 1건 중 1건이 100%로 뜨면 그건 지표가 아니라 오도다.

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');

const registry = (ticker: string, close: number): ProviderRegistry => ({
  CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
    { date: '2026-07-20', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    {
      date: '2026-08-01',
      open: close,
      high: Math.max(close, 100),
      low: Math.min(close, 100),
      close,
      volume: 1,
    },
  ]),
});

async function publish(ticker: string) {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: `${ticker} 전망`,
      summary: '요약',
      content: '본문',
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
        deadline: DEADLINE,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, registry(ticker, 120), draft.id, researcherId, PUBLISH_NOW);
  return draft.id;
}

const find = (ms: Awaited<ReturnType<typeof getOpsMetrics>>, key: string) =>
  ms.find((m) => m.key === key)!;

beforeAll(async () => {
  prisma = createTestDb('ops-metrics-');
  await seedTestInstruments(
    prisma,
    ['KRW-OM1', 'KRW-OM2'].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker,
      shortable: true,
    })),
  );
  const r = await prisma.user.create({
    data: { email: 'r@ops.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@ops.io', identityVerified: true } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('운영 건강 지표', () => {
  it('데이터가 없으면 비율을 지어내지 않는다 — 0으로 나눈 자리는 —로 남는다', async () => {
    const ms = await getOpsMetrics(prisma, BATCH_NOW);
    expect(find(ms, 'leadTime').value).toBe('—');
    expect(find(ms, 'zeroPurchase').value).toBe('—');
    expect(ms.every((m) => !m.alert)).toBe(true); // 표본 0에서 경보가 뜨면 안 된다
  });

  // **판정 엔진이 완벽해도 물건이 안 팔리면 서비스는 죽는다.**
  // 이 실패는 다른 어떤 지표에도 나타나지 않는다
  it('안 팔린 채 끝난 카드를 센다 — 아직 파는 중인 카드는 분모에 안 넣는다', async () => {
    await publish('KRW-OM1'); // 안 팔림
    const sold = await publish('KRW-OM2');
    const bought = await purchaseReport(prisma, sold, buyerId, PUBLISH_NOW);
    // **paidAt은 DB 기본값(실시각)이라 가상 시각과 어긋난다.** 리드타임과 재구매
    // 판정이 둘 다 이 값을 시간축으로 쓰므로 픽스처에서 못 박는다
    await prisma.purchase.update({ where: { id: bought.id }, data: { paidAt: PUBLISH_NOW } });

    // 시한 전에는 둘 다 "결판난 카드"가 아니다 — 넣으면 늘 나쁘게 보인다
    expect(find(await getOpsMetrics(prisma, PUBLISH_NOW), 'zeroPurchase').value).toBe('—');

    // 시한이 지나면 둘 다 결판났고, 그중 하나가 0건이다
    const after = find(await getOpsMetrics(prisma, BATCH_NOW), 'zeroPurchase');
    expect(after.value).toBe('50.0%');
    expect(after.sample).toContain('2장 중 1장');
  });

  it('비율에는 반드시 분모가 붙는다 — 1건 중 1건이 100%로 뜨면 오도다', async () => {
    const ms = await getOpsMetrics(prisma, BATCH_NOW);
    for (const m of ms) {
      if (m.value.endsWith('%')) expect(m.sample).toMatch(/\d/);
    }
  });

  // 이 서비스의 존립을 결정하는 하나 — 특히 **환불받은 사람이 다시 오는가**
  it('판정을 겪은 구매자와 그중 환불 경험자를 나눠 센다', async () => {
    await judgeAndSettleDueCards(prisma, registry('KRW-OM2', 90), BATCH_NOW, 'CRYPTO'); // 실패 → 환불

    const m = find(await getOpsMetrics(prisma, BATCH_NOW), 'repurchase');
    expect(m.sample).toContain('구매자 1명');
    expect(m.sample).toContain('환불 경험자');
    expect(m.value).toBe('0.0%'); // 아직 다시 안 샀다
    expect(m.alert).toBe(true); // 재구매 0%는 눈에 띄어야 한다
  });

  // **이 숫자가 곧 리서처의 현금전환주기(CCC)다.** 구매자에게는 피드백 대기지만
  // 리서처에게는 매출이 에스크로에 묶여 있는 기간 그 자체다 — 길어지면 A급 공급자가
  // "3개월 동안 한 푼도 못 받는 곳"이라는 이유로 조용히 이탈한다
  it('결제 → 판정 리드타임을 잰다 — 이게 리서처의 현금전환주기다', async () => {
    const m = find(await getOpsMetrics(prisma, BATCH_NOW), 'leadTime');
    // 결제 7/12 → 판정 8/2 = 21일
    expect(m.value).toBe('21.0일');
    expect(m.sample).toContain('1건');
    expect(m.meaning).toContain('현금전환주기');
  });

  // **확장 가능성의 지표다.** 100건에 5건을 손대면 1,000건에서는 50건이고,
  // 그때 사람이 병목이 된다 — 자동화 우선순위를 이 숫자가 정한다
  it('수동 개입을 종류별로 나눠 센다', async () => {
    const m = find(await getOpsMetrics(prisma, BATCH_NOW), 'manual');
    expect(m.sample).toContain('판정 되돌리기');
    expect(m.sample).toContain('CS 무효화');
    expect(m.value).toContain('100건당');
  });
});
