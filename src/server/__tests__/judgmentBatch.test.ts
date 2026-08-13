import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import { researcherSeasonScores, seasonOf } from '../scoreService';

// 돈의 흐름 전체 통합 테스트:
// 게시 → 구매(에스크로) → 시한 도래 → 판정 배치 → 정산·크레딧 → 점수 집계 → 규율 연동

let prisma: PrismaClient;
let researcherId: string;
let researcherUserId: string;
let buyerAId: string;
let buyerBId: string;

const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z'); // 시한(8/1) 다음 날

function makeDraft(ticker: string, direction: 'UP' | 'DOWN' = 'UP', confidence = 5) {
  return {
    researcherId,
    title: `${ticker} 전망`,
    summary: '요약',
    content: '본문',
    priceKrw: 10_000,
    prepaymentRatio: 0 as const,
    card: {
      assetClass: 'CRYPTO' as const,
      ticker,
      assetName: ticker,
      direction,
      targetType: 'RETURN_PCT' as const,
      targetValue: 10,
      confidence,
      selfStability: 5,
      deadline: new Date('2026-08-01T00:00:00Z'),
    },
  };
}

/** 기준가 100 고정, 시한 종가를 지정할 수 있는 코인 픽스처 */
function registryWithOutcome(ticker: string, closeAtDeadline: number): ProviderRegistry {
  const provider = new FixtureMarketDataProvider()
    .setCurrentPrice(ticker, 100)
    .setQuotes(ticker, [
      { date: '2026-07-20', open: 100, high: 105, low: 95, close: 100, volume: 1 },
      {
        date: '2026-08-01',
        open: closeAtDeadline,
        high: Math.max(closeAtDeadline, 100),
        low: Math.min(closeAtDeadline, 100),
        close: closeAtDeadline,
        volume: 1,
      },
    ]);
  return { CRYPTO: provider };
}

async function publishAndBuy(ticker: string, closeAtDeadline: number, confidence = 5) {
  const registry = registryWithOutcome(ticker, closeAtDeadline);
  const draft = await createDraftReport(prisma, makeDraft(ticker, 'UP', confidence), DRAFT_NOW);
  await publishReport(prisma, registry, draft.id, researcherId, PUBLISH_NOW);
  await purchaseReport(prisma, draft.id, buyerAId, PUBLISH_NOW);
  await purchaseReport(prisma, draft.id, buyerBId, PUBLISH_NOW);
  return { reportId: draft.id, registry };
}

beforeAll(async () => {
  prisma = createTestDb('judgment-batch-');
  await seedTestInstruments(prisma);

  const researcher = await prisma.user.create({
    data: {
      email: 'r@test.io',
      identityVerified: true,
      researcherProfile: { create: {} },
    },
    include: { researcherProfile: true },
  });
  researcherId = researcher.researcherProfile!.id;
  researcherUserId = researcher.id;
  buyerAId = (
    await prisma.user.create({ data: { email: 'a@test.io', identityVerified: true } })
  ).id;
  buyerBId = (
    await prisma.user.create({ data: { email: 'b@test.io', identityVerified: true } })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('구매·에스크로', () => {
  it('구매 검증: 자기 구매·미인증·초안 구매 차단', async () => {
    const { reportId } = await publishAndBuy('KRW-AAA', 112); // 이후 HIT 케이스로 사용
    await expect(purchaseReport(prisma, reportId, researcherUserId)).rejects.toThrow(/자기 리포트/);

    const unverified = await prisma.user.create({
      data: { email: 'u@test.io', identityVerified: false },
    });
    await expect(purchaseReport(prisma, reportId, unverified.id, PUBLISH_NOW)).rejects.toThrow(
      /본인 인증/,
    );

    const draft = await createDraftReport(prisma, makeDraft('KRW-DRAFT'), DRAFT_NOW);
    await expect(purchaseReport(prisma, draft.id, buyerAId)).rejects.toThrow(/판매 중인/);
  });
});

describe('판정 배치 — 정산·크레딧·점수', () => {
  it('HIT: 리서처 정산 + 수수료, 구매자 환급 없음, 플러스 점수', async () => {
    // KRW-AAA는 위에서 이미 게시·구매됨 (기준가 100 → 종가 112 = +12%, +10% 예측 적중)
    const summary = await judgeAndSettleDueCards(
      prisma,
      registryWithOutcome('KRW-AAA', 112),
      BATCH_NOW,
    );
    expect(summary.failed).toBe(0);
    expect(summary.judged).toBeGreaterThanOrEqual(1);

    const judgment = await prisma.judgment.findFirstOrThrow({
      where: { predictionCard: { ticker: 'KRW-AAA' } },
    });
    expect(judgment.outcome).toBe('HIT');
    // 실현은 목표(+10%)로 고정된다 — 시장이 +12%까지 갔어도 초과분은 넣지 않는다
    expect(judgment.realizedReturnPct).toBeCloseTo(10);
    // v4: 10 × 크기10 × c5 × (1−p₀≈0.5226) — 공짜 확률을 공제한 지급
    expect(judgment.score).toBeCloseTo(212, 0);
    expect(judgment.dataSource).toBe('fixture');
    expect(JSON.parse(judgment.marketSnapshotJson!).quotes).toHaveLength(2);

    // 정산: 브론즈 20% 수수료, 선결제 0
    const purchases = await prisma.purchase.findMany({
      where: { report: { predictionCard: { ticker: 'KRW-AAA' } } },
      include: { settlement: true },
    });
    expect(purchases).toHaveLength(2);
    for (const p of purchases) {
      expect(p.escrowStatus).toBe('SETTLED');
      expect(p.settlement!.researcherPayoutKrw).toBe(8_000);
      expect(p.settlement!.platformFeeKrw).toBe(2_000);
      expect(p.settlement!.buyerRefundKrw).toBe(0);
    }
  });

  it('MISS: 성과 연동분 전액 현금 환불, 마이너스 점수', async () => {
    await publishAndBuy('KRW-BBB', 95); // -5% 실현, +10% 예측 → MISS
    await judgeAndSettleDueCards(prisma, registryWithOutcome('KRW-BBB', 95), BATCH_NOW);

    const judgment = await prisma.judgment.findFirstOrThrow({
      where: { predictionCard: { ticker: 'KRW-BBB' } },
    });
    expect(judgment.outcome).toBe('MISS');
    // v4: −10 × 크기10 × c(c+1)/2=15 × p₀≈0.4774 — 게시 시점에 확정되는 하방
    expect(judgment.score).toBeCloseTo(-8, 0);

    const purchases = await prisma.purchase.findMany({
      where: { report: { predictionCard: { ticker: 'KRW-BBB' } } },
      include: { settlement: true },
    });
    for (const p of purchases) {
      // 선결제 0 → 전액 현금 환불 = 원상복구이므로 REFUNDED
      expect(p.escrowStatus).toBe('REFUNDED');
      expect(p.settlement!.buyerRefundKrw).toBe(10_000);
      expect(p.settlement!.refundType).toBe('CASH_REFUND');
    }
  });

  it('판정 시 구매자·리서처 인앱 알림이 함께 생성된다', async () => {
    // 위의 HIT(KRW-AAA)·MISS(KRW-BBB) 판정에서 생성된 알림 검증
    const researcherNotis = await prisma.notification.findMany({
      where: { userId: researcherUserId, type: 'JUDGMENT_RESULT' },
    });
    expect(researcherNotis.some((n) => n.title.includes('적중'))).toBe(true);
    expect(researcherNotis.some((n) => n.title.includes('실패'))).toBe(true);
    const hit = researcherNotis.find((n) => n.title.includes('적중'))!;
    expect(hit.body).toContain('+212점');
    expect(hit.body).toContain('16,000원'); // 구매 2건 × 8,000원 정산

    const buyerNotis = await prisma.notification.findMany({ where: { userId: buyerAId } });
    const missNoti = buyerNotis.find((n) => n.title.includes('실패'))!;
    expect(missNoti.body).toContain('10,000원'); // 현금 환불액 명시
    expect(buyerNotis.some((n) => n.title.includes('적중'))).toBe(true);
    expect(missNoti.readAt).toBeNull(); // 미읽음으로 생성
  });

  it('판정 불가(거래정지): 전액 환불, 수수료 0, 점수 0', async () => {
    const { reportId } = await publishAndBuy('KRW-CCC', 100);
    const haltedRegistry: ProviderRegistry = {
      CRYPTO: new FixtureMarketDataProvider()
        .setCurrentPrice('KRW-CCC', 100)
        .setStatus('KRW-CCC', { delisted: false, halted: true }),
    };
    await judgeAndSettleDueCards(prisma, haltedRegistry, BATCH_NOW);

    const judgment = await prisma.judgment.findFirstOrThrow({
      where: { predictionCard: { report: { id: reportId } } },
    });
    expect(judgment.outcome).toBe('UNDECIDABLE');
    expect(judgment.score).toBe(0);

    const purchases = await prisma.purchase.findMany({
      where: { reportId },
      include: { settlement: true },
    });
    for (const p of purchases) {
      expect(p.escrowStatus).toBe('REFUNDED');
      expect(p.settlement!.platformFeeKrw).toBe(0);
      expect(p.settlement!.buyerRefundKrw).toBe(10_000);
      expect(p.settlement!.refundType).toBe('CASH_REFUND');
    }
  });

  it('데이터 미도달: 판정하지 않고 이월, 에스크로 유지', async () => {
    const { reportId } = await publishAndBuy('KRW-DDD', 100);
    const emptyRegistry: ProviderRegistry = {
      CRYPTO: new FixtureMarketDataProvider().setCurrentPrice('KRW-DDD', 100),
    };
    const summary = await judgeAndSettleDueCards(prisma, emptyRegistry, BATCH_NOW);
    expect(summary.deferred).toBeGreaterThanOrEqual(1);

    const judgment = await prisma.judgment.findFirst({
      where: { predictionCard: { report: { id: reportId } } },
    });
    expect(judgment).toBeNull();
    const purchases = await prisma.purchase.findMany({ where: { reportId } });
    for (const p of purchases) expect(p.escrowStatus).toBe('HELD');
  });

  it('멱등성: 배치 재실행해도 중복 판정·중복 정산 없음', async () => {
    const before = await prisma.judgment.count();
    const summary = await judgeAndSettleDueCards(
      prisma,
      registryWithOutcome('KRW-AAA', 112),
      BATCH_NOW,
    );
    expect(summary.failed).toBe(0);
    // KRW-DDD(이월분)만 재시도 대상 — 이미 판정된 카드는 조회조차 안 됨
    const after = await prisma.judgment.count();
    expect(after).toBe(before);
  });
});

describe('점수 집계 → 규율 연동', () => {
  it('시즌·자산군별 점수 합산 (HIT +212, MISS -8, 불가 0 → CRYPTO +204)', async () => {
    const scores = await researcherSeasonScores(prisma, researcherId, BATCH_NOW);
    expect(scores.CRYPTO).toBeCloseTo(204, 0);
    expect(scores.KR_EQUITY).toBe(0);
  });

  it('시즌 식별자', () => {
    expect(seasonOf(new Date('2026-08-02T00:00:00Z'))).toBe('2026-Q3');
    expect(seasonOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-Q1');
  });
});

// ── 상장폐지 판정 (2026-08-12) ───────────────────────────────────
// 폐지된 종목은 다음 마스터 동기화에서 목록에서 빠져 active=false가 된다.
// 그것만으로는 부족하다 — 우리가 유니버스에서 뺀 종목(ETF 필터)도 같은 상태가 되는데
// 시세는 멀쩡히 나온다. **마스터에서 빠졌고 시세도 없을 때**만 폐지로 본다.

describe('상장폐지 — 마스터에서 사라지고 시세도 없으면 판정 불가·전액 환불', () => {
  it('둘 다 참이면 UNDECIDABLE(DELISTED)로 판정하고 구매자에게 전액 환불한다', async () => {
    const ticker = 'KRW-DEAD';
    await seedTestInstruments(prisma, [{ assetClass: 'CRYPTO', ticker }]);
    const { reportId } = await publishAndBuy(ticker, 100);
    // 폐지: 마스터에서 비활성 + 시세 없음
    await prisma.instrument.updateMany({
      where: { assetClass: 'CRYPTO', ticker },
      data: { active: false },
    });
    const empty: ProviderRegistry = { CRYPTO: new FixtureMarketDataProvider() };

    // 이 배치는 다른 테스트가 남긴 카드도 함께 훑으므로, 요약이 아니라 이 카드를 본다
    await judgeAndSettleDueCards(prisma, empty, BATCH_NOW);

    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId },
      include: { judgment: true },
    });
    expect(card.judgment?.outcome).toBe('UNDECIDABLE');
    expect(card.judgment?.undecidableReason).toBe('DELISTED');
    expect(card.judgment?.score).toBe(0); // 판정 불가는 표본 제외

    const purchases = await prisma.purchase.findMany({ where: { reportId } });
    expect(purchases.every((p) => p.escrowStatus === 'REFUNDED')).toBe(true);
  });

  it('마스터에 살아 있으면 시세가 없어도 이월한다 — 휴장·일시 장애일 수 있다', async () => {
    const ticker = 'KRW-QUIET';
    await seedTestInstruments(prisma, [{ assetClass: 'CRYPTO', ticker }]);
    const { reportId } = await publishAndBuy(ticker, 100);
    const empty: ProviderRegistry = { CRYPTO: new FixtureMarketDataProvider() };

    const summary = await judgeAndSettleDueCards(prisma, empty, BATCH_NOW);
    expect(summary.deferred).toBeGreaterThan(0);

    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId },
      include: { judgment: true },
    });
    expect(card.judgment).toBeNull();
  });
});
