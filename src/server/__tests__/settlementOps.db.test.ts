import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import {
  getCooldownHold,
  SETTLEMENT_COOLDOWN_HOURS,
  SettlementCooldownError,
} from '../settlementCooldown';
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
// 쿨다운이 끝난 뒤 (settlementCooldown) — **상수에서 유도한다.**
// 시각을 손으로 적으면 쿨다운을 조정할 때마다 무관한 시험이 무더기로 깨진다
const EXEC_NOW = new Date(BATCH_NOW.getTime() + (SETTLEMENT_COOLDOWN_HOURS + 1) * 3_600_000);

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

// **되돌리기 도구는 돈이 남아 있을 때만 도구다.**
//
// 판정이 잘못됐다는 것을 알아도 정산이 이미 실행됐으면 되돌릴 돈이 없다. 그런데
// 지금까지 그 창의 길이는 **운영자가 얼마나 빨리 클릭하느냐**였고, 큐가 오래된
// 순이라 방금 만들어진 잘못된 정산이 오히려 맨 앞에 왔다.
describe('정산 쿨다운', () => {
  const RIGHT_AFTER = new Date(BATCH_NOW.getTime() + 60 * 60_000); // 판정 1시간 뒤

  it('판정 직후에는 큐에 뜨지 않는다', async () => {
    expect(await getPendingRefunds(prisma, RIGHT_AFTER)).toHaveLength(0);
    expect(await getPendingPayouts(prisma, RIGHT_AFTER)).toHaveLength(0);

    // 24시간이 지나면 그대로 나온다
    expect(await getPendingRefunds(prisma, EXEC_NOW)).toHaveLength(1);
    expect(await getPendingPayouts(prisma, EXEC_NOW)).toHaveLength(1);
  });

  // **목록 필터는 화면의 편의이고 이것이 집행이다** — API를 직접 부르는 경로
  // (스크립트·자동화·탈취된 세션)는 목록을 거치지 않는다
  it('큐를 건너뛰고 직접 불러도 거부한다 — 지급도 환불도', async () => {
    const [payout] = await getPendingPayouts(prisma, EXEC_NOW);
    await expect(
      executePayout(
        prisma,
        { settlementId: payout.id, operatorUserId: OPERATOR, confirmedSettled: true },
        RIGHT_AFTER,
      ),
    ).rejects.toBeInstanceOf(SettlementCooldownError);

    const [refund] = await getPendingRefunds(prisma, EXEC_NOW);
    await expect(
      executeRefund(
        prisma,
        { settlementId: refund.id, operatorUserId: OPERATOR, method: 'BANK_TRANSFER', bankReference: 'X1' },
        RIGHT_AFTER,
      ),
    ).rejects.toBeInstanceOf(SettlementCooldownError);

    // 거부는 아무것도 실행하지 않는다
    expect(
      (await prisma.settlement.findUniqueOrThrow({ where: { id: payout.id } })).payoutExecutedAt,
    ).toBeNull();
  });

  // **큐에서 빼는 것과 숨기는 것은 다르다** — 존재까지 안 보이면 운영자가
  // "오늘 나갈 돈이 없다"고 착각한 채로 퇴근한다
  it('묶인 금액은 요약으로 알린다 — 언제 풀리는지까지', async () => {
    const hold = await getCooldownHold(prisma, RIGHT_AFTER);
    expect(hold.count).toBe(2);
    expect(hold.amountKrw).toBe(18_000); // 지급 8,000 + 환불 10,000
    expect(hold.nextExecutableAt).toEqual(
      new Date(BATCH_NOW.getTime() + SETTLEMENT_COOLDOWN_HOURS * 3_600_000),
    );

    // 풀리고 나면 묶인 것이 없다
    expect((await getCooldownHold(prisma, EXEC_NOW)).count).toBe(0);
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

// **지급 직전에 이의가 들어오면 돈이 나가면 안 된다** (2026-08-16, 외부 검토 D-5 ②).
//
// 이의 검사와 실제 쓰기 사이에는 쿨다운 조회·한도 집계·PG 지연 계산이 들어간다.
// 그 사이에 구매자가 이의를 제기하면 앞의 검사는 이미 지나갔고 돈이 나간다.
// 창은 좁지만 **쿨다운 만료 직후가 이의가 몰리는 시각**이라 하필 겹치기 쉽다.
//
// 이중 지급은 `payoutExecutedAt: null` 조건이 이미 막고 있었다 — 안 막힌 것은
// "그 사이 상황이 바뀌었는가" 쪽이다.
describe('지급 직전 이의 재확인', () => {
  it('검사 통과 후 트랜잭션 직전에 접수된 이의도 지급을 막는다', async () => {
    // 앞선 시험들이 지급을 다 실행했으므로, 미실행 상태로 되돌려 무대를 만든다
    const found = await prisma.settlement.findFirstOrThrow({
      where: { researcherPayoutKrw: { gt: 0 } },
      include: { purchase: true },
    });
    await prisma.settlement.update({
      where: { id: found.id },
      data: { payoutExecutedAt: null, payoutExecutedBy: null },
    });
    const s = found;

    // 앞선 검사를 통과시킨 뒤, 쓰기 직전에 이의가 생기는 상황을 만든다.
    // `$transaction`이 다시 조회하므로 여기서 만들어 두면 그 재확인에 걸린다
    const dispute = await prisma.judgmentDispute.create({
      data: {
        purchaseId: s.purchaseId,
        buyerId: s.purchase.buyerId,
        actorRole: 'PURCHASER',
        category: 'PRICE_DATA',
        observed: '8/1 종가 71,200원',
        status: 'OPEN',
      },
    });

    await expect(
      executePayout(
        prisma,
        { settlementId: s.id, operatorUserId: OPERATOR, confirmedSettled: true },
        new Date(s.settledAt.getTime() + (SETTLEMENT_COOLDOWN_HOURS + 1) * 3_600_000),
      ),
    ).rejects.toThrow(/이의/);

    // **돈이 안 나갔다**
    const after = await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.payoutExecutedAt).toBeNull();

    await prisma.judgmentDispute.delete({ where: { id: dispute.id } });
  });
});
