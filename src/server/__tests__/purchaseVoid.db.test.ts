import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { getResearcherFinance } from '../financeQueries';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { getReportDetail } from '../leaderboardQueries';
import {
  markDisputed,
  PurchaseVoidError,
  resolveDispute,
  voidPurchase,
} from '../purchaseVoidService';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// **CS 환불은 판정 환불과 다른 일이다.**
//
// 판정 환불("예측이 빗나가 성과 연동분을 돌려준다")은 상품이 약속대로 작동한 결과라
// 구매자는 읽고 결과를 기다린 셈이고 본문이 남아야 한다. CS 환불은 **거래 자체의
// 무효화**라 "산 적 없는 것"이 되어야 한다 — 같은 값을 쓰면 결제 → 열람 → 즉시
// CS환불이 공짜 열람 경로가 된다.

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;
let buyer2Id: string;
let operatorId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const NOW = new Date('2026-07-13T00:00:00Z');

const registry = (ticker: string): ProviderRegistry => ({
  CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
    { date: '2026-07-20', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { date: '2026-08-01', open: 120, high: 120, low: 120, close: 120, volume: 1 },
  ]),
});

/** 게시 → 구매(결제키 포함). 결제키가 있어야 PG 취소를 부를 수 있다 */
async function published(ticker: string, buyers: string[]) {
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
  await publishReport(prisma, registry(ticker), draft.id, researcherId, PUBLISH_NOW);
  const ids: string[] = [];
  for (const b of buyers) {
    const p = await purchaseReport(prisma, draft.id, b, PUBLISH_NOW);
    await prisma.purchase.update({
      where: { id: p.id },
      data: { paymentKey: `pk_${p.id}` },
    });
    ids.push(p.id);
  }
  return { reportId: draft.id, purchaseIds: ids };
}

beforeAll(async () => {
  prisma = createTestDb('purchase-void-');
  await seedTestInstruments(
    prisma,
    ['KRW-V1', 'KRW-V2', 'KRW-V3', 'KRW-V4'].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker,
      shortable: true,
    })),
  );
  const r = await prisma.user.create({
    data: { email: 'r@void.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b1@void.io', identityVerified: true } })).id;
  buyer2Id = (await prisma.user.create({ data: { email: 'b2@void.io', identityVerified: true } }))
    .id;
  operatorId = (
    await prisma.user.create({
      data: { email: 'op@void.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;
});

beforeEach(() => {
  // PG 취소는 성공했다고 본다 — 이 시험의 대상은 취소 호출이 아니라 **그 뒤의 장부**다
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ status: 'CANCELED' }), { status: 200 })),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

describe('CS 환불 — 거래 무효화', () => {
  it('무효화하면 열람이 즉시 닫힌다 — 판정 환불과 다른 점이 이것이다', async () => {
    const { reportId, purchaseIds } = await published('KRW-V1', [buyerId]);

    // 무효화 전: 본문이 보인다
    const before = await getReportDetail(prisma, reportId, buyerId);
    expect(before!.purchase).not.toBeNull();

    await voidPurchase(
      prisma,
      { purchaseId: purchaseIds[0], operatorUserId: operatorId, reason: '중복 결제' },
      NOW,
    );

    // 무효화 후: **산 적 없는 것**이 된다. 이게 없으면 결제 → 열람 → 즉시 환불이
    // 공짜 열람 경로가 된다
    const after = await getReportDetail(prisma, reportId, buyerId);
    expect(after!.purchase).toBeNull();

    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { id: purchaseIds[0] } });
    expect(purchase.escrowStatus).toBe('CANCELLED');

    // 시도 행이 남는다 — 그 id가 곧 멱등키였고, 감사 근거이기도 하다
    const attempt = await prisma.refundAttempt.findFirstOrThrow({
      where: { purchaseId: purchaseIds[0] },
    });
    expect(attempt.type).toBe('CS_CANCEL');
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.settlementId).toBeNull();
    expect(attempt.amountKrw).toBe(10_000);
  });

  // 판정 후에 이 길을 쓰면 카드의 판정은 남은 채 구매만 사라져 정산 합계가 어긋난다
  it('판정된 카드의 구매는 거부하고 되돌리기 쪽으로 보낸다', async () => {
    const { purchaseIds } = await published('KRW-V2', [buyerId]);
    await judgeAndSettleDueCards(
      prisma,
      registry('KRW-V2'),
      new Date('2026-08-02T00:00:00Z'),
      'CRYPTO',
    );

    await expect(
      voidPurchase(
        prisma,
        { purchaseId: purchaseIds[0], operatorUserId: operatorId, reason: 'x' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_JUDGED' });
  });

  it('끝나지 않은 시도가 있으면 새로 만들지 않는다 — 새 키는 두 번 빠진다', async () => {
    const { purchaseIds } = await published('KRW-V3', [buyerId]);
    await prisma.refundAttempt.create({
      data: {
        type: 'CS_CANCEL',
        purchaseId: purchaseIds[0],
        amountKrw: 10_000,
        method: 'PG_CANCEL',
        operatorId,
        status: 'PENDING',
      },
    });

    await expect(
      voidPurchase(
        prisma,
        { purchaseId: purchaseIds[0], operatorUserId: operatorId, reason: 'x' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'IN_FLIGHT' });
  });
});

describe('차지백 — 한 구매만 멈춘다', () => {
  it('분쟁 건은 정산에서 빠지지만 카드 판정과 다른 구매는 그대로 간다', async () => {
    const { purchaseIds } = await published('KRW-V4', [buyerId, buyer2Id]);
    await markDisputed(prisma, purchaseIds[0], NOW);

    // 리서처 화면: 분쟁 금액이 **정산 대기와 섞이지 않는다**
    const finance = await getResearcherFinance(prisma, researcherId);
    const row = finance.byReport.find((r) => r.disputedKrw > 0)!;
    expect(row.disputedKrw).toBe(10_000);
    expect(row.heldKrw).toBe(10_000); // 나머지 한 건은 그대로 대기

    // 판정은 카드 단위로 그대로 난다 — 분쟁은 구매자 한 사람의 일이다
    const s = await judgeAndSettleDueCards(
      prisma,
      registry('KRW-V4'),
      new Date('2026-08-02T00:00:00Z'),
      'CRYPTO',
    );
    expect(s.judged).toBe(1);

    // 정산은 HELD였던 구매에만 생긴다
    expect(await prisma.settlement.count({ where: { purchaseId: purchaseIds[0] } })).toBe(0);
    expect(await prisma.settlement.count({ where: { purchaseId: purchaseIds[1] } })).toBe(1);
  });

  // **되돌아오는 길이 없으면 DISPUTED는 블랙홀이다.** 이겼는데 판정이 이미 났으면
  // 그 구매의 정산이 비어 있고 배치는 다시 돌지 않는다 — 조용히 넘기면 리서처 돈이 사라진다
  it('이긴 분쟁이 판정 뒤였으면 수동 정산이 필요하다고 알린다', async () => {
    const disputed = await prisma.purchase.findFirstOrThrow({
      where: { escrowStatus: 'DISPUTED' },
    });
    const r = await resolveDispute(
      prisma,
      { purchaseId: disputed.id, resolution: 'WON', operatorUserId: operatorId },
      NOW,
    );
    expect(r.settlementNeeded).toBe(true);
    expect(
      (await prisma.purchase.findUniqueOrThrow({ where: { id: disputed.id } })).escrowStatus,
    ).toBe('HELD');
  });

  it('분쟁 중이 아닌 구매는 확정할 수 없다', async () => {
    const held = await prisma.purchase.findFirstOrThrow({ where: { escrowStatus: 'HELD' } });
    await expect(
      resolveDispute(
        prisma,
        { purchaseId: held.id, resolution: 'LOST', operatorUserId: operatorId },
        NOW,
      ),
    ).rejects.toBeInstanceOf(PurchaseVoidError);
  });
});
