import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import {
  executePayout,
  executeRefund,
  getPendingPayouts,
  getPendingRefunds,
  SettlementOpsError,
} from '../settlementOpsService';

// 정산 지시서 실행: 판정이 만든 환불·지급 지시서를 운영자가 실행·기록하고
// 이중 실행이 막히는지, 당사자 알림이 생성되는지 검증한다.

let prisma: PrismaClient;
let researcherId: string;
let researcherUserId: string;
let buyerId: string;
const OPERATOR = 'op-user-id';

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');
const EXEC_NOW = new Date('2026-08-03T00:00:00Z');

function registryFor(ticker: string, closeAtDeadline: number): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
      { date: '2026-07-20', open: 100, high: 105, low: 95, close: 100, volume: 1 },
      {
        date: '2026-08-01',
        open: closeAtDeadline,
        high: Math.max(closeAtDeadline, 100),
        low: Math.min(closeAtDeadline, 100),
        close: closeAtDeadline,
        volume: 1,
      },
    ]),
  };
}

beforeAll(async () => {
  prisma = createTestDb('settlement-ops-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@s.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  researcherUserId = r.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@s.io', identityVerified: true } })).id;

  for (const ticker of ['KRW-AAA', 'KRW-BBB']) {
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
          deadline: new Date('2026-08-01T00:00:00Z'),
        },
      },
      DRAFT_NOW,
    );
    await publishReport(prisma, registryFor(ticker, 100), draft.id, researcherId, PUBLISH_NOW);
    await purchaseReport(prisma, draft.id, buyerId, PUBLISH_NOW);
  }
  await judgeAndSettleDueCards(prisma, registryFor('KRW-AAA', 112), BATCH_NOW); // HIT → 지급
  await judgeAndSettleDueCards(prisma, registryFor('KRW-BBB', 95), BATCH_NOW); // MISS → 환불
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('지시서 조회', () => {
  it('미실행 환불(MISS)·지급(HIT)이 각각 잡힌다', async () => {
    const refunds = await getPendingRefunds(prisma);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].buyerRefundKrw).toBe(10_000);
    expect(refunds[0].purchase.report.title).toBe('KRW-BBB 전망');

    const payouts = await getPendingPayouts(prisma);
    expect(payouts).toHaveLength(1);
    expect(payouts[0].researcherPayoutKrw).toBe(8_000);
  });
});

describe('환불 실행', () => {
  it('실행 기록 + 구매자 알림, 재실행은 거부', async () => {
    const [refund] = await getPendingRefunds(prisma);
    await executeRefund(
      prisma,
      // 계좌이체는 멱등키가 없어 이체 참조번호가 필수다 (중복 송금 방지의 유일한 수단)
      { settlementId: refund.id, operatorUserId: OPERATOR, method: 'BANK_TRANSFER', bankReference: 'TRX-0001' },
      EXEC_NOW,
    );

    const updated = await prisma.settlement.findUniqueOrThrow({ where: { id: refund.id } });
    expect(updated.refundMethod).toBe('BANK_TRANSFER');
    expect(updated.refundExecutedAt).toEqual(EXEC_NOW);
    expect(updated.refundExecutedBy).toBe(OPERATOR);
    expect(await getPendingRefunds(prisma)).toHaveLength(0); // 큐에서 제거

    const noti = await prisma.notification.findFirstOrThrow({
      where: { userId: buyerId, type: 'REFUND_EXECUTED' },
    });
    expect(noti.title).toContain('10,000원');
    expect(noti.body).toContain('계좌이체');

    await expect(
      executeRefund(prisma, { settlementId: refund.id, operatorUserId: OPERATOR, method: 'PG_CANCEL' }),
    ).rejects.toThrow(/이미 환불/);
  });

  it('환불액이 없는 정산(HIT) 건은 환불 실행 거부', async () => {
    const [payout] = await getPendingPayouts(prisma);
    await expect(
      executeRefund(prisma, { settlementId: payout.id, operatorUserId: OPERATOR, method: 'PG_CANCEL' }),
    ).rejects.toThrow(SettlementOpsError);
  });
});

describe('지급 실행', () => {
  // **아직 우리에게 안 온 돈을 내주지 않는다.** 판정은 결제 시점 기준으로 나지만
  // 토스가 우리 계좌에 넣어 주는 것은 며칠 뒤다 — 그 사이에 지급하면 회사 돈을
  // 먼저 내주는 것이고, 규모가 커지면 그대로 자본 잠식이다
  it('PG 입금 전에는 거부한다 — 확인 표시가 있어야 넘어간다', async () => {
    const [payout] = await getPendingPayouts(prisma);
    await expect(
      executePayout(prisma, { settlementId: payout.id, operatorUserId: OPERATOR }, new Date()),
    ).rejects.toThrow(/PG 입금/);
  });

  it('실행 기록 + 리서처 알림, 재실행은 거부', async () => {
    const [payout] = await getPendingPayouts(prisma);
    // 운영자가 토스 콘솔에서 입금을 확인한 경우 (픽스처의 paidAt은 DB 실시각이라
    // 가상 시각 EXEC_NOW로는 지연 방어선을 넘길 수 없다)
    await executePayout(
      prisma,
      { settlementId: payout.id, operatorUserId: OPERATOR, confirmedSettled: true },
      EXEC_NOW,
    );

    const updated = await prisma.settlement.findUniqueOrThrow({ where: { id: payout.id } });
    expect(updated.payoutExecutedAt).toEqual(EXEC_NOW);
    expect(updated.payoutExecutedBy).toBe(OPERATOR);
    expect(await getPendingPayouts(prisma)).toHaveLength(0);

    const noti = await prisma.notification.findFirstOrThrow({
      where: { userId: researcherUserId, type: 'PAYOUT_EXECUTED' },
    });
    expect(noti.title).toContain('8,000원');

    await expect(
      executePayout(prisma, { settlementId: payout.id, operatorUserId: OPERATOR }),
    ).rejects.toThrow(/이미 지급/);
  });
});
