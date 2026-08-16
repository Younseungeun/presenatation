import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  getManualJudgmentQueue,
  manualJudgeCard,
  ManualJudgmentError,
} from '../manualJudgmentService';
import { decideApproval } from '../operatorApprovalService';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// 운영자 판정 보류 큐: 7일 이상 이월된 카드만 노출되고, 수동 판정이
// 자동 경로와 동일한 점수·정산 결과를 남기는지 검증한다.

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;
let operatorId: string;
let secondOperatorId: string;
const cardIdByTicker: Record<string, string> = {};

/**
 * 기계 판정 이력이 없는 카드의 수동 판정에는 2인 승인이 걸린다 (검토 4차 Q1).
 * 판정을 실행하려는 시험은 이 헬퍼로 승인부터 받는다 — 첫 판정 시도가 요청을 올리고,
 * 다른 운영자가 승인하고, 같은 판정을 다시 실행하는 실제 절차 그대로다.
 */
async function approveFirstManual(cardId: string, judge: () => Promise<unknown>) {
  await expect(judge()).rejects.toThrow(/다른 운영자의 승인/);
  const req = await prisma.operatorApproval.findFirstOrThrow({
    where: { action: 'FIRST_MANUAL_JUDGMENT', targetId: cardId, status: 'PENDING' },
  });
  await decideApproval(
    prisma,
    { approvalId: req.id, approverUserId: secondOperatorId, approve: true },
    STALE_NOW,
  );
}

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const FRESH_NOW = new Date('2026-08-05T00:00:00Z'); // 시한 경과 4일 — 아직 자동 판정 우선
const STALE_NOW = new Date('2026-08-10T00:00:00Z'); // 시한 경과 9일 — 보류 큐 대상

function publishRegistry(ticker: string): ProviderRegistry {
  return { CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100) };
}

async function publishAndBuy(ticker: string) {
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
        targetValue: 10,
        confidence: 5,
        selfStability: 5,
        deadline: DEADLINE,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, publishRegistry(ticker), draft.id, researcherId, PUBLISH_NOW);
  await purchaseReport(prisma, draft.id, buyerId, PUBLISH_NOW);
  const card = await prisma.predictionCard.findUniqueOrThrow({ where: { reportId: draft.id } });
  cardIdByTicker[ticker] = card.id;
}

beforeAll(async () => {
  prisma = createTestDb('manual-judge-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@m.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@m.io', identityVerified: true } })).id;
  operatorId = (
    await prisma.user.create({
      data: { email: 'op@m.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;
  secondOperatorId = (
    await prisma.user.create({
      data: { email: 'op2@m.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;

  await publishAndBuy('KRW-AAA'); // 수동 HIT 예정
  await publishAndBuy('KRW-BBB'); // 판정 불가 처리 예정
  await publishAndBuy('KRW-CCC'); // 큐 노출 확인용 (판정하지 않음)
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getManualJudgmentQueue — 보류 큐 조회', () => {
  it('시한 경과 7일 미만 카드는 노출하지 않는다 (자동 판정 우선)', async () => {
    expect(await getManualJudgmentQueue(prisma, FRESH_NOW)).toHaveLength(0);
  });

  it('7일 이상 이월된 카드를 경과 일수·에스크로 건수와 함께 반환', async () => {
    const queue = await getManualJudgmentQueue(prisma, STALE_NOW);
    expect(queue).toHaveLength(3);
    expect(queue[0].staleDays).toBe(9);
    expect(queue[0].heldPurchases).toBe(1);
    expect(queue[0].basePrice).toBe(100); // 게시 시 실시간가로 확정
  });
});

describe('manualJudgeCard — 수동 판정', () => {
  it('시한 경과 7일 미만이면 거부', async () => {
    await expect(
      manualJudgeCard(
        prisma,
        {
          cardId: cardIdByTicker['KRW-AAA'],
          operatorUserId: operatorId,
          reason: '조기 시도',
          decision: { type: 'PRICE', priceAtDeadline: 112 },
        },
        FRESH_NOW,
      ),
    ).rejects.toThrow(ManualJudgmentError);
  });

  it('사유 없이는 거부', async () => {
    await expect(
      manualJudgeCard(
        prisma,
        {
          cardId: cardIdByTicker['KRW-AAA'],
          operatorUserId: operatorId,
          reason: '  ',
          decision: { type: 'PRICE', priceAtDeadline: 112 },
        },
        STALE_NOW,
      ),
    ).rejects.toThrow(/사유/);
  });

  it('필요한 시세가 비어 있으면 기록하지 않고 되돌린다', async () => {
    await expect(
      manualJudgeCard(
        prisma,
        {
          cardId: cardIdByTicker['KRW-AAA'],
          operatorUserId: operatorId,
          reason: '가격 누락',
          decision: { type: 'PRICE' },
        },
        STALE_NOW,
      ),
    ).rejects.toThrow(/판정할 수 없습니다/);
  });

  it('시세 입력 판정: 자동 경로와 동일한 점수·정산 (HIT → +212점, 수수료 20% 정산)', async () => {
    // 기계 판정 이력이 없는 카드다 — 첫 시도는 승인 요청으로 멈추고(요청은 자동으로
    // 올라간다), 다른 운영자가 승인해야 같은 판정이 실행된다 (검토 4차 Q1).
    // 운영자가 넣는 숫자가 곧 원천 데이터인 자리라, 이 창구가 조작되면 앞선 방어가 다 무력하다
    const judge = () =>
      manualJudgeCard(
        prisma,
        {
          cardId: cardIdByTicker['KRW-AAA'],
          operatorUserId: operatorId,
          reason: '공급자 결측 — 거래소 공시 종가 112 확인',
          decision: { type: 'PRICE', priceAtDeadline: 112 },
        },
        STALE_NOW,
      );
    await approveFirstManual(cardIdByTicker['KRW-AAA'], judge);
    const result = await judge();
    expect(result.outcome).toBe('HIT');
    // v4: 10×크기×c×(1−p₀). 픽스처 종목이 조용해(σ=0.5%/일) p₀가 작아 지급이 크다
    expect(result.score).toBeCloseTo(212, 0);

    const judgment = await prisma.judgment.findUniqueOrThrow({
      where: { predictionCardId: cardIdByTicker['KRW-AAA'] },
      include: { predictionCard: { include: { report: { include: { purchases: { include: { settlement: true } } } } } } },
    });
    expect(judgment.dataSource).toBe(`manual:${operatorId}`);
    expect(JSON.parse(judgment.marketSnapshotJson!)).toMatchObject({
      manual: true,
      reason: '공급자 결측 — 거래소 공시 종가 112 확인',
    });
    const purchase = judgment.predictionCard.report.purchases[0];
    expect(purchase.escrowStatus).toBe('SETTLED');
    expect(purchase.settlement!.researcherPayoutKrw).toBe(8_000);
  });

  it('판정 불가 처리: 전액 현금 환불 + 수수료 0 — 이쪽도 돈이라 같은 관문을 지난다', async () => {
    const judge = () =>
      manualJudgeCard(
        prisma,
        {
          cardId: cardIdByTicker['KRW-BBB'],
          operatorUserId: operatorId,
          reason: '마켓 상장폐지로 시세 확인 불가',
          decision: { type: 'UNDECIDABLE', undecidableReason: 'DELISTED' },
        },
        STALE_NOW,
      );
    await approveFirstManual(cardIdByTicker['KRW-BBB'], judge);
    const result = await judge();
    expect(result.outcome).toBe('UNDECIDABLE');
    expect(result.score).toBe(0);

    const purchase = await prisma.purchase.findFirstOrThrow({
      where: { report: { predictionCard: { id: cardIdByTicker['KRW-BBB'] } } },
      include: { settlement: true },
    });
    expect(purchase.escrowStatus).toBe('REFUNDED');
    expect(purchase.settlement!.buyerRefundKrw).toBe(10_000);
    expect(purchase.settlement!.platformFeeKrw).toBe(0);
    expect(purchase.settlement!.refundType).toBe('CASH_REFUND');
  });

  it('이미 판정된 카드는 재판정 불가 (멱등)', async () => {
    await expect(
      manualJudgeCard(
        prisma,
        {
          cardId: cardIdByTicker['KRW-AAA'],
          operatorUserId: operatorId,
          reason: '중복 시도',
          decision: { type: 'PRICE', priceAtDeadline: 112 },
        },
        STALE_NOW,
      ),
    ).rejects.toThrow(/이미 판정/);
  });

  it('판정된 카드는 큐에서 사라진다', async () => {
    const queue = await getManualJudgmentQueue(prisma, STALE_NOW);
    expect(queue.map((q) => q.ticker)).toEqual(['KRW-CCC']);
  });
});
