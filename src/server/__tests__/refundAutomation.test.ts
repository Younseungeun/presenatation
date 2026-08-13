import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import { executeRefund, getPendingRefunds, retryRefundAttempt } from '../settlementOpsService';

// **환불은 이제 코드가 돈을 움직인다.**
//
// 지금까지 정산 콘솔의 "환불 실행"은 사람이 토스 콘솔에서 취소한 뒤 남기는 기록일
// 뿐이었다. 여기서부터 PG_CANCEL은 실제로 취소 API를 부른다. 그래서 지켜야 할 것이 셋이다:
//
//  ① **금액.** 실패(MISS)는 선결제분을 빼고 성과 연동분만 돌려준다 — 전액 취소하면
//     리서처 몫까지 빠진다. 부분 취소액이 지시서와 같은 값이어야 한다
//  ② **순서.** 돈이 먼저, 기록이 나중. 뒤집으면 취소가 실패했을 때 "환불 완료" 알림까지
//     나간 채 돈은 그대로 있고, 그 건은 미실행 목록에서도 사라져 아무도 다시 보지 않는다
//  ③ **멱등.** ②의 순서는 "취소는 됐는데 기록이 실패"를 남긴다. 운영자는 다시 누른다 —
//     멱등키가 없으면 그때 두 번 빠진다

const cancelCalls: {
  paymentKey: string;
  cancelReason: string;
  cancelAmount?: number;
  idempotencyKey?: string;
}[] = [];
let cancelShouldFail = false;
/** PG가 거절한 것이 아니라 **응답 자체를 못 받은** 상황 (네트워크 단절) */
let networkDown = false;

vi.mock('../tossPayments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tossPayments')>();
  return {
    ...actual,
    cancelTossPayment: vi.fn(async (p: (typeof cancelCalls)[number]) => {
      cancelCalls.push(p);
      // TossPaymentError가 아닌 일반 오류 = 응답을 못 받았다는 뜻
      if (networkDown) throw new TypeError('fetch failed: 네트워크 연결이 끊겼습니다');
      if (cancelShouldFail) throw new actual.TossPaymentError('이미 취소된 결제입니다', 'ALREADY_CANCELED');
      return { paymentKey: p.paymentKey, status: 'CANCELED' };
    }),
  };
});

let prisma: PrismaClient;
let buyerId: string;
/** 전액 환불(판정 불가 아님 — 선결제 0%인 MISS) · 결제 키 있음 */
let fullRefundId: string;
/** 부분 환불(선결제 10%인 MISS) · 결제 키 있음 */
let partialRefundId: string;
/** 결제 키 없는 스텁 구매 */
let noKeyRefundId: string;

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

/** 실패(MISS)로 끝나는 카드 하나를 만들어 사고 판정까지 돌린다 → 정산 id */
async function seedMissedPurchase(
  researcherId: string,
  ticker: string,
  prepaymentRatio: 0 | 10,
  paymentKey?: string,
): Promise<string> {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: `${ticker} 전망`,
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      prepaymentRatio,
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
  await purchaseReport(prisma, draft.id, buyerId, PUBLISH_NOW, { method: 'CARD' }, undefined, paymentKey);
  await judgeAndSettleDueCards(prisma, registryFor(ticker, 95), BATCH_NOW); // 목표 미달 → MISS
  const purchase = await prisma.purchase.findFirstOrThrow({
    where: { reportId: draft.id },
    include: { settlement: true },
  });
  return purchase.settlement!.id;
}

beforeAll(async () => {
  prisma = createTestDb('refund-auto-');
  await seedTestInstruments(prisma);

  // 선결제는 등급이 열어준다 — 부분 환불을 시험하려면 0%보다 위가 필요하다 (domain/fees)
  const r = await prisma.user.create({
    data: {
      email: 'r@s.io',
      identityVerified: true,
      researcherProfile: { create: { tier: 'GOLD' } },
    },
    include: { researcherProfile: true },
  });
  buyerId = (await prisma.user.create({ data: { email: 'b@s.io', identityVerified: true } })).id;

  const researcherId = r.researcherProfile!.id;
  fullRefundId = await seedMissedPurchase(researcherId, 'KRW-AAA', 0, 'pk_full');
  partialRefundId = await seedMissedPurchase(researcherId, 'KRW-BBB', 10, 'pk_partial');
  noKeyRefundId = await seedMissedPurchase(researcherId, 'KRW-CCC', 0, undefined);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  cancelCalls.length = 0;
  cancelShouldFail = false;
  networkDown = false;
});

describe('PG 취소 환불 자동 실행', () => {
  it('선결제 0%면 전액이 그대로 취소된다', async () => {
    await executeRefund(
      prisma,
      { settlementId: fullRefundId, operatorUserId: OPERATOR, method: 'PG_CANCEL' },
      EXEC_NOW,
    );

    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0].paymentKey).toBe('pk_full');
    expect(cancelCalls[0].cancelAmount).toBe(10_000);

    // **멱등키는 정산이 아니라 시도에 붙는다.** 정산 id로 잡으면 "같은 정산의 두 번째
    // 취소"가 영원히 불가능해진다 — 토스가 첫 성공 응답을 그대로 돌려주므로 코드는
    // 성공으로 알고 돈은 안 나간다. 판정 정정으로 추가 환불이 필요한 날 조용히 틀린다
    const attempt = await prisma.refundAttempt.findFirstOrThrow({
      where: { settlementId: fullRefundId },
    });
    expect(cancelCalls[0].idempotencyKey).toBe(`refund_attempt_${attempt.id}`);
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.amountKrw).toBe(10_000);
    // 구매자 카드 명세서에 남는 문구라 "왜 돌려받았는지"가 보여야 한다
    expect(cancelCalls[0].cancelReason).toContain('예측 실패');

    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: fullRefundId } });
    expect(s.refundMethod).toBe('PG_CANCEL');
    expect(s.refundExecutedAt).toEqual(EXEC_NOW);
  });

  it('선결제 10%면 성과 연동분만 부분 취소한다 — 전액 취소하면 리서처 몫까지 빠진다', async () => {
    const before = await prisma.settlement.findUniqueOrThrow({ where: { id: partialRefundId } });
    expect(before.buyerRefundKrw).toBe(9_000); // 10,000 × (1 − 0.1)
    expect(before.researcherPayoutKrw).toBeGreaterThan(0); // 리서처에게 갈 몫이 남아 있다

    await executeRefund(
      prisma,
      { settlementId: partialRefundId, operatorUserId: OPERATOR, method: 'PG_CANCEL' },
      EXEC_NOW,
    );

    expect(cancelCalls[0].cancelAmount).toBe(9_000);
    expect(cancelCalls[0].cancelAmount).toBe(before.buyerRefundKrw); // 지시서 금액과 같은 값 하나
  });

  it('결제 키가 없는 구매는 자동 취소하지 않고 계좌이체로 안내한다', async () => {
    await expect(
      executeRefund(
        prisma,
        { settlementId: noKeyRefundId, operatorUserId: OPERATOR, method: 'PG_CANCEL' },
        EXEC_NOW,
      ),
    ).rejects.toThrow(/계좌이체로 환불/);

    expect(cancelCalls).toHaveLength(0);
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: noKeyRefundId } });
    expect(s.refundExecutedAt).toBeNull(); // 큐에 그대로 남는다
  });

  it('계좌이체 환불은 PG를 부르지 않는다 — 결제 키가 없는 건의 폴백이다', async () => {
    await executeRefund(
      prisma,
      { settlementId: noKeyRefundId, operatorUserId: OPERATOR, method: 'BANK_TRANSFER' },
      EXEC_NOW,
    );
    expect(cancelCalls).toHaveLength(0);
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: noKeyRefundId } });
    expect(s.refundMethod).toBe('BANK_TRANSFER');
  });

  it('취소 API가 던지면 기록하지 않고 큐에 남는다 — 완료 알림이 나가면 아무도 다시 안 본다', async () => {
    const failing = await seedMissedPurchase(
      (await prisma.researcherProfile.findFirstOrThrow()).id,
      'KRW-DDD',
      0,
      'pk_fail',
    );
    const notisBefore = await prisma.notification.count({ where: { type: 'REFUND_EXECUTED' } });
    cancelShouldFail = true;

    await expect(
      executeRefund(
        prisma,
        { settlementId: failing, operatorUserId: OPERATOR, method: 'PG_CANCEL' },
        EXEC_NOW,
      ),
    ).rejects.toThrow(/이미 취소된 결제입니다/);

    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: failing } });
    expect(s.refundExecutedAt).toBeNull();
    expect(s.refundMethod).toBeNull();
    // 구매자에게 "환불 완료"가 나가지 않았다 — 돈은 그대로인데 완료됐다고 믿게 하면 안 된다
    expect(await prisma.notification.count({ where: { type: 'REFUND_EXECUTED' } })).toBe(
      notisBefore,
    );
    // 큐에 남아 있어 다시 시도할 수 있다
    expect((await getPendingRefunds(prisma)).some((r) => r.id === failing)).toBe(true);

    // 실패한 시도도 사유와 함께 남는다 — 성공만 남기면 "왜 두 번 눌렀나"를 못 읽는다
    const attempt = await prisma.refundAttempt.findFirstOrThrow({
      where: { settlementId: failing },
    });
    expect(attempt.status).toBe('FAILED');
    expect(attempt.error).toContain('이미 취소된 결제입니다');
  });

  it('다시 시도하면 **새 키**로 나간다 — 정정 환불이 조용히 삼켜지지 않는다', async () => {
    const settlementId = await seedMissedPurchase(
      (await prisma.researcherProfile.findFirstOrThrow()).id,
      'KRW-DRAFT',
      0,
      'pk_retry',
    );

    cancelShouldFail = true;
    await expect(
      executeRefund(
        prisma,
        { settlementId, operatorUserId: OPERATOR, method: 'PG_CANCEL' },
        EXEC_NOW,
      ),
    ).rejects.toThrow();

    cancelShouldFail = false;
    await executeRefund(
      prisma,
      { settlementId, operatorUserId: OPERATOR, method: 'PG_CANCEL' },
      EXEC_NOW,
    );

    expect(cancelCalls).toHaveLength(2);
    expect(cancelCalls[0].idempotencyKey).not.toBe(cancelCalls[1].idempotencyKey);
    const attempts = await prisma.refundAttempt.findMany({ where: { settlementId } });
    expect(attempts.map((a) => a.status).sort()).toEqual(['FAILED', 'SUCCEEDED']);
  });
});

// **"PG가 거절했다"와 "응답을 못 받았다"는 다르다.**
//
// 토스가 HTTP로 거절하면 돈이 안 나갔다는 것을 우리가 **안다** — 그 시도는 끝났고
// 다음은 새 키로 나가야 한다. 반대로 네트워크가 끊겨 응답 자체를 못 받으면 나갔는지
// 알 수 없다. 그때 새 시도를 만들면 **새 멱등키로 한 번 더 나가** 두 번 빠진다.
describe('응답을 못 받은 시도는 PENDING으로 남고, 같은 키로만 이어받는다', () => {
  let settlementId: string;

  beforeEach(async () => {
    settlementId = await seedMissedPurchase(
      (await prisma.researcherProfile.findFirstOrThrow()).id,
      'KRW-BTC',
      0,
      'pk_net',
    );
    cancelCalls.length = 0;
    networkDown = true;
    await expect(
      executeRefund(
        prisma,
        { settlementId, operatorUserId: OPERATOR, method: 'PG_CANCEL' },
        EXEC_NOW,
      ),
    ).rejects.toThrow(/확인할 수 없습니다/);
    networkDown = false;
  });

  it('네트워크 실패는 FAILED가 아니라 PENDING으로 남는다', async () => {
    const attempt = await prisma.refundAttempt.findFirstOrThrow({ where: { settlementId } });
    expect(attempt.status).toBe('PENDING');
    expect(attempt.error).toContain('네트워크');
  });

  it('PENDING이 남아 있으면 새 실행을 막는다 — 새 키로 나가면 두 번 빠진다', async () => {
    await expect(
      executeRefund(
        prisma,
        { settlementId, operatorUserId: OPERATOR, method: 'PG_CANCEL' },
        EXEC_NOW,
      ),
    ).rejects.toThrow(/끝나지 않은 환불 시도/);
    expect(cancelCalls).toHaveLength(1); // 첫 시도 말고는 나가지 않았다
  });

  it('재시도는 **같은 키**로 나가고 성공하면 시도와 정산이 함께 닫힌다', async () => {
    const attempt = await prisma.refundAttempt.findFirstOrThrow({ where: { settlementId } });
    await retryRefundAttempt(prisma, { attemptId: attempt.id, operatorUserId: OPERATOR }, EXEC_NOW);

    expect(cancelCalls).toHaveLength(2);
    expect(cancelCalls[1].idempotencyKey).toBe(cancelCalls[0].idempotencyKey);

    const after = await prisma.refundAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe('SUCCEEDED');
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(s.refundExecutedAt).toEqual(EXEC_NOW);
    expect(s.refundMethod).toBe('PG_CANCEL');
  });

  it('이미 끝난 시도는 재시도할 수 없다', async () => {
    const attempt = await prisma.refundAttempt.findFirstOrThrow({ where: { settlementId } });
    await retryRefundAttempt(prisma, { attemptId: attempt.id, operatorUserId: OPERATOR }, EXEC_NOW);
    await expect(
      retryRefundAttempt(prisma, { attemptId: attempt.id, operatorUserId: OPERATOR }, EXEC_NOW),
    ).rejects.toThrow(/이미 끝난 시도/);
  });
});
