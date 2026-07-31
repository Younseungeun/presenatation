import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { PublishValidationError } from '@/domain/publishReport';
import { FixtureComplianceScreener } from '@/infra/compliance/screener';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  ComplianceTakedownError,
  forceWithdrawReport,
  getPendingComplianceReviews,
  runScreening,
} from '../complianceService';
import { purchaseReport } from '../purchaseService';
import {
  approvePendingReport,
  createDraftReport,
  publishReport,
  rejectPendingReport,
} from '../reportService';

// 게시 전 컴플라이언스 검수가 실제 게시 플로우를 막는지/통과시키는지 종단 검증

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;
let operatorUserId: string;
let takedownResearcherId: string;
let takedownResearcherUserId: string;
const OPERATOR = 'op-user-id';

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const registry = { CRYPTO: new FixtureMarketDataProvider().setCurrentPrice('KRW-BTC', 100) };

// 자산군별 동시 활성 카드 상한(브론즈 5)에 걸리지 않게, 강제 철회 테스트는 별도 리서처를 쓴다
function draftInput(content: string, title = 'BTC 전망', authorId = researcherId) {
  return {
    researcherId: authorId,
    title,
    summary: '요약',
    content,
    priceKrw: 10_000,
    prepaymentRatio: 0 as const,
    card: {
      assetClass: 'CRYPTO' as const,
      ticker: 'KRW-BTC',
      assetName: '비트코인',
      direction: 'UP' as const,
      targetType: 'RETURN_PCT' as const,
      targetValue: 15,
      confidence: 5,
      selfStability: 5,
      selfProfitability: 5,
      deadline: new Date('2026-10-01T00:00:00Z'),
    },
  };
}

beforeAll(async () => {
  prisma = createTestDb('compliance-');
  await seedTestInstruments(prisma);
  const r = await prisma.user.create({
    data: { email: 'r@c.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@c.io', identityVerified: true } })).id;
  operatorUserId = (
    await prisma.user.create({ data: { email: 'op@c.io', role: 'OPERATOR' } })
  ).id;
  const t = await prisma.user.create({
    data: { email: 't@c.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  takedownResearcherId = t.researcherProfile!.id;
  takedownResearcherUserId = t.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('runScreening — 규칙과 AI 조합', () => {
  const clean = {
    title: 't',
    summary: 's',
    content: '공개 실적 자료를 근거로 상승을 전망합니다.',
    assetClass: 'CRYPTO' as const,
    assetName: '비트코인',
    direction: 'UP' as const,
  };

  it('규칙이 차단하면 AI를 호출하지 않는다 (비용·지연 절약)', async () => {
    let called = false;
    const spy = {
      reviewerId: 'spy',
      async screen() {
        called = true;
        return { findings: [] };
      },
    };
    const result = await runScreening({ ...clean, content: '원금 보장됩니다' }, spy);
    expect(result.decision).toBe('BLOCK');
    expect(result.reviewer).toBe('rule');
    expect(called).toBe(false);
  });

  it('AI가 찾은 위반이 결정에 반영된다', async () => {
    const screener = new FixtureComplianceScreener([
      { category: 'PROFIT_GUARANTEE', severity: 'BLOCK', quote: '우회 표현', reason: 'r' },
    ]);
    const result = await runScreening(clean, screener);
    expect(result.decision).toBe('BLOCK');
    expect(result.reviewer).toBe('rule+fixture');
  });

  it('AI 검수 실패는 게시를 막지 않고 운영자 검토로 넘긴다', async () => {
    const failing = new FixtureComplianceScreener([], new Error('API 장애'));
    const result = await runScreening(clean, failing);
    expect(result.decision).toBe('UNAVAILABLE');
    expect(result.needsOperatorReview).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('검수기가 없으면 규칙만으로 판정', async () => {
    expect((await runScreening(clean, null)).reviewer).toBe('rule');
  });

  it('AI 토큰 사용량이 결과에 실려 온다 (비용 측정·숙고량 신호)', async () => {
    const screener = new FixtureComplianceScreener([], undefined, {
      inputTokens: 2_400,
      outputTokens: 720,
    });
    const result = await runScreening(clean, screener);
    expect(result.usage).toEqual({ inputTokens: 2_400, outputTokens: 720 });
  });
});

describe('publishReport — 검수 연동', () => {
  it('금지 표현이 있으면 게시가 차단되고 시도가 기록된다', async () => {
    const draft = await createDraftReport(
      prisma,
      draftInput('무조건 오릅니다. 원금 보장 수준입니다.'),
      DRAFT_NOW,
    );
    await expect(
      publishReport(prisma, registry, draft.id, researcherId, PUBLISH_NOW),
    ).rejects.toThrow(PublishValidationError);

    // 리포트는 초안 그대로, 차단 이력은 남는다
    const after = await prisma.report.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('DRAFT');
    const review = await prisma.complianceReview.findFirstOrThrow({
      where: { reportId: draft.id },
    });
    expect(review.decision).toBe('BLOCK');
    expect(JSON.parse(review.findingsJson)[0].category).toBe('PROFIT_GUARANTEE');
  });

  it('정상 리포트는 통과하고 PASS가 기록된다', async () => {
    const draft = await createDraftReport(
      prisma,
      draftInput('온체인 지표와 공개 데이터를 근거로 상승을 전망합니다.', '정상 리포트'),
      DRAFT_NOW,
    );
    const published = await publishReport(prisma, registry, draft.id, researcherId, PUBLISH_NOW);
    expect(published.status).toBe('PUBLISHED');

    const review = await prisma.complianceReview.findFirstOrThrow({
      where: { reportId: draft.id },
    });
    expect(review.decision).toBe('PASS');
    expect(review.needsOperatorReview).toBe(false);
  });

  it('검수 사용량이 기록되고 숙고 지수가 계산된다', async () => {
    const draft = await createDraftReport(
      prisma,
      draftInput('공개 자료를 근거로 상승을 전망합니다.', '사용량 기록'),
      DRAFT_NOW,
    );
    const screener = new FixtureComplianceScreener([], undefined, {
      inputTokens: 2_000,
      outputTokens: 600,
    });
    await publishReport(prisma, registry, draft.id, researcherId, PUBLISH_NOW, screener);

    const review = await prisma.complianceReview.findFirstOrThrow({
      where: { reportId: draft.id },
    });
    expect(review.inputTokens).toBe(2_000);
    expect(review.outputTokens).toBe(600);
    expect(review.deliberationRatio).toBeCloseTo(0.3); // 600/2000
  });

  it('WARN은 게시하지 않고 보류한다 — 판매 전에 사람이 결정한다', async () => {
    const draft = await createDraftReport(
      prisma,
      draftInput('시장에 카더라가 돌고 있습니다. 상승을 전망합니다.', '풍문 포함'),
      DRAFT_NOW,
    );
    const result = await publishReport(prisma, registry, draft.id, researcherId, PUBLISH_NOW);
    expect(result.status).toBe('PENDING_REVIEW');
    // 보류 중에는 판매 조건이 확정되지 않는다 (승인 시점 시세로 확정)
    expect(result.publishedAt).toBeNull();
    expect(result.feeRateBp).toBeNull();
    expect(
      (await prisma.predictionCard.findFirstOrThrow({ where: { reportId: draft.id } })).basePrice,
    ).toBeNull();

    const review = await prisma.complianceReview.findFirstOrThrow({
      where: { reportId: draft.id },
    });
    expect(review.decision).toBe('WARN');
    expect(review.needsOperatorReview).toBe(true);

    // 큐에 올린 것만으로는 부족 — 운영자가 열어보기 전에 알아야 한다
    const alarm = await prisma.notification.findFirstOrThrow({
      where: { userId: operatorUserId, type: 'COMPLIANCE_REVIEW', title: { contains: '풍문 포함' } },
    });
    expect(alarm.link).toBe('/admin/compliance');
    // 리서처도 왜 안 올라갔는지 알아야 한다
    await prisma.notification.findFirstOrThrow({
      where: { type: 'COMPLIANCE_PENDING', title: { contains: '게시 보류' } },
    });
  });

  it('AI 검수 실패도 보류 대상 (검수 공백을 사람이 메운다)', async () => {
    const draft = await createDraftReport(
      prisma,
      draftInput('공개 자료를 근거로 상승을 전망합니다.', '검수 장애'),
      DRAFT_NOW,
    );
    const failing = new FixtureComplianceScreener([], new Error('API 장애'));
    const result = await publishReport(
      prisma,
      registry,
      draft.id,
      researcherId,
      PUBLISH_NOW,
      failing,
    );
    expect(result.status).toBe('PENDING_REVIEW');

    const alarm = await prisma.notification.findFirstOrThrow({
      where: { userId: operatorUserId, type: 'COMPLIANCE_REVIEW', title: { contains: '검수 장애' } },
    });
    expect(alarm.title).toContain('AI 검수 실패');
  });

  it('보류 건은 구매할 수 없다', async () => {
    const draft = await createDraftReport(
      prisma,
      draftInput('시장에 카더라가 돌고 있습니다. 상승을 전망합니다.', '보류 구매 시도'),
      DRAFT_NOW,
    );
    await publishReport(prisma, registry, draft.id, researcherId, PUBLISH_NOW);
    await expect(purchaseReport(prisma, draft.id, buyerId, PUBLISH_NOW)).rejects.toThrow();
  });

  it('PASS는 알림을 만들지 않는다 (운영자 알림 피로 방지)', async () => {
    const before = await prisma.notification.count({ where: { type: 'COMPLIANCE_REVIEW' } });
    const draft = await createDraftReport(
      prisma,
      draftInput('공개 실적 자료를 근거로 상승을 전망합니다.', '통과 건'),
      DRAFT_NOW,
    );
    await publishReport(prisma, registry, draft.id, researcherId, PUBLISH_NOW);
    expect(await prisma.notification.count({ where: { type: 'COMPLIANCE_REVIEW' } })).toBe(before);
  });
});

describe('보류 건에 대한 운영자 결정 — 승인/반려', () => {
  const DECIDE_NOW = new Date('2026-07-13T00:00:00Z');

  async function held(title: string) {
    const draft = await createDraftReport(
      prisma,
      draftInput('시장에 카더라가 돌고 있습니다. 상승을 전망합니다.', title, takedownResearcherId),
      DRAFT_NOW,
    );
    await publishReport(prisma, registry, draft.id, takedownResearcherId, PUBLISH_NOW);
    return draft.id;
  }

  it('승인하면 그때서야 게시되고 기준가·수수료가 확정된다', async () => {
    const reportId = await held('승인 대상');
    expect((await getPendingComplianceReviews(prisma)).some((r) => r.report.id === reportId)).toBe(
      true,
    );

    const published = await approvePendingReport(prisma, registry, reportId, OPERATOR, DECIDE_NOW);
    expect(published.status).toBe('PUBLISHED');
    // 기준가는 제출 시점(7/12)이 아니라 승인 시점(7/13) 기준으로 확정된다 —
    // 보류 기간의 시세 변동이 흡수되어 정보 이점이 생기지 않는다
    expect(published.publishedAt).toEqual(DECIDE_NOW);
    expect(published.feeRateBp).toBeGreaterThan(0);
    expect(published.basePrice).toBe(100);

    expect((await getPendingComplianceReviews(prisma)).some((r) => r.report.id === reportId)).toBe(
      false,
    );
    await prisma.notification.findFirstOrThrow({
      where: { userId: takedownResearcherUserId, title: { contains: '게시 승인' } },
    });
    // 승인 후에는 판매 가능
    await purchaseReport(prisma, reportId, buyerId, DECIDE_NOW);
  });

  it('반려하면 초안으로 돌아가고 사유가 리서처에게 전달된다', async () => {
    const reportId = await held('반려 대상');
    await rejectPendingReport(prisma, reportId, OPERATOR, '풍문 근거를 공개 자료로 교체 필요', DECIDE_NOW);

    const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    expect(report.status).toBe('DRAFT'); // 삭제가 아니라 초안 복귀 — 고쳐서 재제출 가능
    expect(report.publishedAt).toBeNull();
    expect((await getPendingComplianceReviews(prisma)).some((r) => r.report.id === reportId)).toBe(
      false,
    );

    const noti = await prisma.notification.findFirstOrThrow({
      where: { userId: takedownResearcherUserId, title: { contains: '게시 반려' } },
    });
    expect(noti.body).toContain('공개 자료로 교체 필요');
  });

  it('사유 없는 반려·보류 아닌 건에 대한 결정은 거부된다', async () => {
    const reportId = await held('가드 확인');
    await expect(rejectPendingReport(prisma, reportId, OPERATOR, '   ')).rejects.toThrow(
      PublishValidationError,
    );
    await approvePendingReport(prisma, registry, reportId, OPERATOR, DECIDE_NOW);
    await expect(
      approvePendingReport(prisma, registry, reportId, OPERATOR, DECIDE_NOW),
    ).rejects.toThrow(PublishValidationError);
    await expect(rejectPendingReport(prisma, reportId, OPERATOR, '사유')).rejects.toThrow(
      PublishValidationError,
    );
  });
});

describe('forceWithdrawReport — 운영자 강제 철회', () => {
  const TAKEDOWN_NOW = new Date('2026-07-13T00:00:00Z');

  /** 보류 → 운영자 승인 → 판매된 리포트 (승인 후 재검토로 내려야 하는 상황) */
  async function publishedWithBuyer(title: string) {
    const draft = await createDraftReport(
      prisma,
      draftInput('시장에 카더라가 돌고 있습니다. 상승을 전망합니다.', title, takedownResearcherId),
      DRAFT_NOW,
    );
    await publishReport(prisma, registry, draft.id, takedownResearcherId, PUBLISH_NOW);
    await approvePendingReport(prisma, registry, draft.id, OPERATOR, PUBLISH_NOW);
    await purchaseReport(prisma, draft.id, buyerId, PUBLISH_NOW);
    return draft.id;
  }

  it('게시 중단 + 즉시 전액 환불 + 점수 0', async () => {
    const reportId = await publishedWithBuyer('강제 철회 대상');

    const summary = await forceWithdrawReport(
      prisma,
      { reportId, operatorUserId: OPERATOR, reason: '풍문을 근거로 제시 — 공개 자료 확인 불가' },
      TAKEDOWN_NOW,
    );
    expect(summary).toEqual({ reportId, refundedPurchases: 1, refundedAmountKrw: 10_000 });

    // 리포트·카드 상태 (기록은 남고 상태만 전이)
    const report = await prisma.report.findUniqueOrThrow({
      where: { id: reportId },
      include: { predictionCard: { include: { judgment: true } } },
    });
    expect(report.status).toBe('CLOSED');
    expect(report.predictionCard!.withdrawnAt).toEqual(TAKEDOWN_NOW);

    // 판정: 시한(10/1)을 기다리지 않고 즉시 판정 불가로 확정
    const judgment = report.predictionCard!.judgment!;
    expect(judgment.outcome).toBe('UNDECIDABLE');
    expect(judgment.undecidableReason).toBe('WITHDRAWN');
    expect(judgment.score).toBe(0);
    expect(judgment.dataSource).toBe(`takedown:${OPERATOR}`);
    expect(JSON.parse(judgment.marketSnapshotJson!)).toMatchObject({
      takedown: true,
      operatorUserId: OPERATOR,
    });

    // 정산: 전액 환불, 수수료·리서처 정산 없음
    const settlement = await prisma.settlement.findFirstOrThrow({
      where: { purchase: { reportId } },
    });
    expect(settlement.buyerRefundKrw).toBe(10_000);
    expect(settlement.researcherPayoutKrw).toBe(0);
    expect(settlement.platformFeeKrw).toBe(0);
    expect(
      (await prisma.purchase.findFirstOrThrow({ where: { reportId } })).escrowStatus,
    ).toBe('REFUNDED');

    // 리서처 통지에 사유가 실린다
    const noti = await prisma.notification.findFirstOrThrow({
      where: { userId: takedownResearcherUserId, type: 'COMPLIANCE_TAKEDOWN' },
    });
    expect(noti.body).toContain('공개 자료 확인 불가');

    // 검토 큐에 남지 않는다
    const pending = await getPendingComplianceReviews(prisma);
    expect(pending.some((r) => r.report.id === reportId)).toBe(false);
  });

  it('사유 없이는 철회할 수 없다 (감사 기록 필수)', async () => {
    const reportId = await publishedWithBuyer('사유 누락');
    await expect(
      forceWithdrawReport(prisma, { reportId, operatorUserId: OPERATOR, reason: '  ' }),
    ).rejects.toThrow(ComplianceTakedownError);
    expect(
      (await prisma.report.findUniqueOrThrow({ where: { id: reportId } })).status,
    ).toBe('PUBLISHED');
  });

  it('이미 철회·판정된 건은 재실행할 수 없다 (이중 환불 차단)', async () => {
    const reportId = await publishedWithBuyer('재실행 방지');
    await forceWithdrawReport(
      prisma,
      { reportId, operatorUserId: OPERATOR, reason: '위반' },
      TAKEDOWN_NOW,
    );
    await expect(
      forceWithdrawReport(prisma, { reportId, operatorUserId: OPERATOR, reason: '위반' }),
    ).rejects.toThrow(ComplianceTakedownError);
    expect(await prisma.settlement.count({ where: { purchase: { reportId } } })).toBe(1);
  });

  it('게시되지 않은 초안은 대상이 아니다', async () => {
    const draft = await createDraftReport(
      prisma,
      draftInput('본문', '초안 상태', takedownResearcherId),
      DRAFT_NOW,
    );
    await expect(
      forceWithdrawReport(prisma, { reportId: draft.id, operatorUserId: OPERATOR, reason: '위반' }),
    ).rejects.toThrow(/초안/);
  });
});
