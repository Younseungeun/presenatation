import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { JudgmentRevertBlocked, revertJudgment } from '../judgmentRevertService';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import { researcherSeasonTotals } from '../scoreService';

// **판정은 돈과 점수를 동시에 움직인다.** 되돌리기가 넷 중 하나라도 빠뜨리면 안 된다:
// 에스크로 · 정산 · 시즌 점수 · 규율 래더의 증거(info).
//
// 마지막이 가장 위험하다 — 증거는 **평생 누적**이라 잘못 쌓이면 그 리서처의 신뢰도
// 상한이 영구히 틀어지고 본인은 이유를 알 수 없다. 이 시험이 고정하는 것은
// "행 하나를 지우면 점수와 증거가 함께 사라진다"는 구조적 성질이다.

let prisma: PrismaClient;
let researcherId: string;
let buyerAId: string;
let buyerBId: string;
let operatorId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');

/** 시한 종가로 적중·실패를 정하는 코인 픽스처 (기준가 100) */
function registryWithClose(ticker: string, close: number): ProviderRegistry {
  return {
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
  };
}

/** 게시 → 두 사람이 구매 → 판정까지 끝낸 카드 하나 */
async function judgedCard(ticker: string, close: number) {
  const registry = registryWithClose(ticker, close);
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
  await publishReport(prisma, registry, draft.id, researcherId, PUBLISH_NOW);
  await purchaseReport(prisma, draft.id, buyerAId, PUBLISH_NOW);
  await purchaseReport(prisma, draft.id, buyerBId, PUBLISH_NOW);
  await judgeAndSettleDueCards(prisma, registry, BATCH_NOW, 'CRYPTO');

  const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker } });
  const judgment = await prisma.judgment.findUniqueOrThrow({
    where: { predictionCardId: card.id },
  });
  return { reportId: draft.id, cardId: card.id, judgment, registry };
}

beforeAll(async () => {
  prisma = createTestDb('judgment-revert-');
  await seedTestInstruments(
    prisma,
    ['KRW-RV1', 'KRW-RV2', 'KRW-RV3', 'KRW-RV4', 'KRW-RV5'].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker,
      shortable: true,
    })),
  );
  const researcher = await prisma.user.create({
    data: { email: 'r@revert.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = researcher.researcherProfile!.id;
  buyerAId = (await prisma.user.create({ data: { email: 'a@revert.io', identityVerified: true } }))
    .id;
  buyerBId = (await prisma.user.create({ data: { email: 'b@revert.io', identityVerified: true } }))
    .id;
  operatorId = (
    await prisma.user.create({
      data: { email: 'op@revert.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('판정 되돌리기', () => {
  it('돈·점수·증거가 함께 되감기고 카드는 다시 미판정이 된다', async () => {
    const { cardId, judgment, registry } = await judgedCard('KRW-RV1', 120); // 적중
    expect(judgment.outcome).toBe('HIT');
    expect(judgment.score ?? 0).toBeGreaterThan(0);

    // 되돌리기 전: 점수도 증거도 집계에 잡힌다
    const before = await researcherSeasonTotals(prisma, researcherId, BATCH_NOW);
    expect(before.score.CRYPTO).toBeGreaterThan(0);
    expect(before.evidence.CRYPTO).not.toBe(0);

    const r = await revertJudgment(
      prisma,
      { judgmentId: judgment.id, operatorUserId: operatorId, reason: '시세 소스 오류' },
      BATCH_NOW,
    );
    expect(r.settlements).toBe(2);

    // 판정·정산이 사라지고 에스크로가 다시 잠긴다
    expect(await prisma.judgment.findUnique({ where: { id: judgment.id } })).toBeNull();
    expect(await prisma.settlement.count()).toBe(0);
    const purchases = await prisma.purchase.findMany({ where: { buyerId: buyerAId } });
    expect(purchases.every((p) => p.escrowStatus === 'HELD')).toBe(true);

    // **점수와 증거는 따로 되돌릴 것이 없다** — 둘 다 Judgment 행을 그때그때 합산한다.
    // 규율 래더의 증거가 여기서 0으로 돌아오는 것이 이 시험의 핵심이다: 잘못 쌓인
    // 증거는 평생 누적이라 남으면 그 리서처의 신뢰도 상한이 영구히 틀어진다
    const after = await researcherSeasonTotals(prisma, researcherId, BATCH_NOW);
    expect(after.score.CRYPTO).toBe(0);
    expect(after.evidence.CRYPTO).toBe(0);

    // 백오프를 지워 다음 배치가 즉시 다시 본다
    const card = await prisma.predictionCard.findUniqueOrThrow({ where: { id: cardId } });
    expect(card.deferCount).toBe(0);
    expect(card.nextAttemptAt).toBeNull();

    // 지운 것을 지웠다는 사실은 남는다 (append-only)
    const tomb = await prisma.judgmentRevert.findFirstOrThrow({
      where: { judgmentId: judgment.id },
    });
    expect(tomb.outcome).toBe('HIT');
    expect(tomb.reason).toBe('시세 소스 오류');
    expect(JSON.parse(tomb.settlementsJson)).toHaveLength(2);

    // **조용히 되돌리지 않는다** — 구매자는 이미 "판정됐다"를 봤다
    const notices = await prisma.notification.count({
      where: { title: { contains: '판정 취소' } },
    });
    expect(notices).toBe(3); // 구매자 2 + 리서처 1

    // 되돌린 카드는 배치가 다시 판정한다 (행을 지운 이유가 이것이다 — unique 제약)
    const again = await judgeAndSettleDueCards(prisma, registry, BATCH_NOW, 'CRYPTO');
    expect(again.judged).toBe(1);
    expect(
      (await prisma.judgment.findUniqueOrThrow({ where: { predictionCardId: cardId } })).outcome,
    ).toBe('HIT');
  });

  // ── 방어선: 돈이 이미 밖으로 나갔으면 거부한다 ────────────
  // 장부만 되돌리면 **DB는 깨끗한데 현실과 다른** 최악의 상태가 된다

  it('리서처 지급이 실행됐으면 거부한다 — 남의 계좌에서 돈을 가져올 수는 없다', async () => {
    const { judgment, reportId } = await judgedCard('KRW-RV2', 120);
    await prisma.settlement.updateMany({
      where: { purchase: { reportId } },
      data: { payoutExecutedAt: BATCH_NOW, payoutExecutedBy: operatorId },
    });

    await expect(
      revertJudgment(
        prisma,
        { judgmentId: judgment.id, operatorUserId: operatorId, reason: 'x' },
        BATCH_NOW,
      ),
    ).rejects.toThrow(JudgmentRevertBlocked);

    // 거부는 아무것도 건드리지 않는다 — 반쯤 되돌린 상태가 가장 나쁘다
    expect(await prisma.judgment.findUnique({ where: { id: judgment.id } })).not.toBeNull();
  });

  it('구매자 환불이 실행됐으면 거부한다 — 되돌리려면 다시 청구해야 한다', async () => {
    const { judgment, reportId } = await judgedCard('KRW-RV3', 90); // 실패 → 환불
    expect(judgment.outcome).toBe('MISS');
    await prisma.settlement.updateMany({
      where: { buyerRefundKrw: { gt: 0 }, purchase: { reportId } },
      data: { refundExecutedAt: BATCH_NOW, refundMethod: 'PG_CANCEL' },
    });

    await expect(
      revertJudgment(
        prisma,
        { judgmentId: judgment.id, operatorUserId: operatorId, reason: 'x' },
        BATCH_NOW,
      ),
    ).rejects.toMatchObject({ code: 'REFUND_EXECUTED' });
  });

  // PENDING은 "나갔는지 우리가 모른다"는 뜻이라 **실행된 것으로 취급**해야 안전하다
  it('끝나지 않은 환불 시도가 있으면 거부한다 — 모르는 상태에서 되돌리지 않는다', async () => {
    const { judgment, reportId } = await judgedCard('KRW-RV4', 90);
    // **이 카드의** 정산이어야 한다 — 앞선 시험들이 남긴 정산을 잡으면 시험이 헛돈다
    const settlement = await prisma.settlement.findFirstOrThrow({
      where: { buyerRefundKrw: { gt: 0 }, purchase: { reportId } },
    });
    await prisma.refundAttempt.create({
      data: {
        settlementId: settlement.id,
        amountKrw: settlement.buyerRefundKrw,
        method: 'PG_CANCEL',
        status: 'PENDING',
        operatorId,
      },
    });

    await expect(
      revertJudgment(
        prisma,
        { judgmentId: judgment.id, operatorUserId: operatorId, reason: 'x' },
        BATCH_NOW,
      ),
    ).rejects.toMatchObject({ code: 'REFUND_IN_FLIGHT' });
  });

  // 등급은 분기 재산정에서만 바뀐다 — 지난 시즌 판정을 되돌려도 그때 기록된
  // TierHistory는 그대로다. 시스템이 못 고치는 것을 조용히 넘기지 않는다
  it('지난 시즌 판정이면 등급 영향을 사람에게 알린다', async () => {
    const { judgment } = await judgedCard('KRW-RV5', 120);
    const nextSeason = new Date('2026-11-05T00:00:00Z'); // 판정은 Q3, 지금은 Q4

    const r = await revertJudgment(
      prisma,
      { judgmentId: judgment.id, operatorUserId: operatorId, reason: 'x' },
      nextSeason,
    );
    expect(r.followUps.some((f) => f.includes('TierHistory'))).toBe(true);
  });
});
