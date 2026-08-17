import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedTestInstruments,
  seedVerifiedPayoutAccount,
} from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { compensationAmountKrw } from '@/domain/compensation';
import { JUDGMENT_HARD_CAP_DAYS, judgeAndSettleDueCards } from '../judgmentBatch';
import {
  CompensationError,
  countUnjudgeableCards,
  executeCompensation,
  getPendingCompensationReviews,
  reviewCompensation,
  sweepPendingCompensations,
  COMPENSATION_REVIEW_OVERDUE_DAYS,
  UNJUDGEABLE_LOOKBACK_DAYS,
} from '../compensationService';
import {
  CompensationBudgetExceeded,
  MONTHLY_COMPENSATION_BUDGET_KRW,
  monthCompensatedKrw,
} from '../compensationBudget';
import { issueOperatorRecheck } from '../operatorApprovalService';
import { todayOutflowKrw } from '../payoutVelocity';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// **판정을 못 해 카드가 닫히면 리서처는 대금도 점수도 못 받는다.**
// 판매는 실제로 일어났고 콘텐츠는 전달됐는데 판정을 못 한 것은 우리 사정이므로,
// 팔린 만큼을 플랫폼 자본으로 메운다. 이 파일이 지키는 것은 셋이다:
//   ① 지시서가 **판정과 같은 트랜잭션에서** 태어난다 (따로 만들면 빠지는 창이 열린다)
//   ② **자동으로 돈이 나가지 않는다** — 전부 사람 확정을 거친다
//   ③ 실행은 **두 벽**(일일 출금 한도·월 보상 예산)을 지난다

let prisma: PrismaClient;
let researcherId: string;
let researcherUserId: string;
const buyerIds: string[] = [];
const OPERATOR = 'op-user-id';

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const PRICE_KRW = 10_000;
const FEE_RATE_BP = 2_000; // 무표기 등급 20%
/** 상한을 넘긴 시각 — 이때 배치를 돌리면 카드가 판정 불가로 닫힌다 */
const PAST_CAP = new Date(DEADLINE.getTime() + (JUDGMENT_HARD_CAP_DAYS + 1) * 86_400_000);

/**
 * 시세를 **넘긴 종목에만** 준다 — 나머지는 이월되다 상한에서 닫힌다
 * (`hard-cap` = DATA_UNKNOWN). 한 회차 안에서 정상 판정과 상한 마감이 함께 일어나는
 * 것이 실제 사고의 모양이기도 하다: 소스가 종목 하나만 못 주는 경우가 가장 흔하다.
 */
function withQuotes(tickers: string[], deadlineClose = 95): ProviderRegistry {
  const p = new FixtureMarketDataProvider();
  for (const t of tickers) {
    p.setCurrentPrice(t, 100).setQuotes(t, [
      { date: '2026-07-20', open: 100, high: 100, low: 100, close: 100, volume: 1 },
      {
        date: '2026-08-01',
        open: deadlineClose,
        high: Math.max(deadlineClose, 100),
        low: Math.min(deadlineClose, 100),
        close: deadlineClose,
        volume: 1,
      },
    ]);
  }
  return { CRYPTO: p };
}

async function publishCard(ticker: string) {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: `${ticker} 전망`,
      summary: 's',
      content: 'c',
      priceKrw: PRICE_KRW,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker,
        assetName: ticker,
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 20,
        confidence: 5,
        selfStability: 5,
        deadline: DEADLINE,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, withQuotes([ticker]), draft.id, researcherId, PUBLISH_NOW);
  return draft.id;
}

/** 상한으로 닫힐 카드 하나 — 구매자 수만큼 팔아 둔다 */
const CAPPED = 'KRW-CMP1';
/** 정상 판정(MISS)될 대조군 — 보상이 붙으면 안 된다 */
const NORMAL = 'KRW-CMP2';
/** 확정 대기 큐를 시험할 카드 — CAPPED와 같은 회차에 함께 닫힌다 */
const BUDGET = 'KRW-CMP3';

let batchSummary: Awaited<ReturnType<typeof judgeAndSettleDueCards>>;

beforeAll(async () => {
  prisma = createTestDb('compensation-');
  await seedTestInstruments(
    prisma,
    [CAPPED, NORMAL, BUDGET].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker,
      shortable: true,
    })),
  );

  const r = await prisma.user.create({
    data: { email: 'r@cmp.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  researcherUserId = r.id;
  // 계좌 관문(assertPayoutAccountReady)이 지급·보상 실행 앞에 있다 — 없으면 한 푼도 안 나간다
  await seedVerifiedPayoutAccount(prisma, researcherUserId);
  await prisma.user.create({ data: { id: OPERATOR, email: 'op@cmp.io', role: 'OPERATOR' } });

  for (const n of [1, 2, 3]) {
    const u = await prisma.user.create({
      data: { email: `b${n}@cmp.io`, identityVerified: true },
    });
    buyerIds.push(u.id);
  }

  // 상한 카드는 **구매자 둘**에게 판다 — 사건은 카드 하나인데 돈은 구매 단위로 움직인다
  const capped = await publishCard(CAPPED);
  for (const b of buyerIds.slice(0, 2)) {
    await purchaseReport(prisma, capped, b, PUBLISH_NOW);
  }
  const normal = await publishCard(NORMAL);
  await purchaseReport(prisma, normal, buyerIds[0], PUBLISH_NOW);
  const budget = await publishCard(BUDGET);
  await purchaseReport(prisma, budget, buyerIds[2], PUBLISH_NOW);

  // **회차는 한 번이다.** 판정 배치는 자산군 단위로 도므로 카드를 하나씩 따로 돌릴 수
  // 없다 — NORMAL만 시세를 주면 같은 회차에서 나머지 둘이 상한으로 닫힌다. 그게 바로
  // 시험하려는 상황이라, 나눠 돌리는 대신 **한 회차의 결과를 나눠 본다**
  batchSummary = await judgeAndSettleDueCards(prisma, withQuotes([NORMAL]), PAST_CAP);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('지시서 생성', () => {
  // **정상 판정에는 붙지 않는다.** 결과가 아니라 사유로 가르므로, 실패 판정(MISS)은
  // 예측이 틀린 것이지 우리가 못 잰 것이 아니다
  it('정상 판정된 카드에는 보상이 붙지 않는다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: NORMAL } });
    const judgment = await prisma.judgment.findUniqueOrThrow({
      where: { predictionCardId: card.id },
    });
    expect(judgment.outcome).toBe('MISS'); // 예측이 틀린 것이지 우리가 못 잰 것이 아니다
    expect(
      await prisma.compensationInstruction.count({ where: { predictionCardId: card.id } }),
    ).toBe(0);
  });

  // **판정과 같은 트랜잭션에서 태어난다.** 따로 만들면 "카드는 닫혔는데 지시서는 없는"
  // 창이 열리고, 닫힌 카드는 정상 판정과 똑같이 보여 아무도 그 사실을 못 찾는다
  it('상한으로 닫힌 카드는 팔린 구매마다 보상 지시서를 만든다', async () => {
    expect(batchSummary.hardCapped.length).toBe(2); // CAPPED · BUDGET

    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: CAPPED } });
    const judgment = await prisma.judgment.findUniqueOrThrow({
      where: { predictionCardId: card.id },
    });
    expect(judgment.outcome).toBe('UNDECIDABLE');

    const rows = await prisma.compensationInstruction.findMany({
      where: { predictionCardId: card.id },
    });
    expect(rows).toHaveLength(2); // 구매자 둘
    for (const row of rows) {
      // 금액 = 판매 대금 − 수수료. 전액이면 장애가 정상 적중보다 이득이 된다
      expect(row.amountKrw).toBe(
        compensationAmountKrw({ amountKrw: PRICE_KRW, feeRateBp: FEE_RATE_BP }),
      );
      expect(row.researcherUserId).toBe(researcherUserId);
      expect(row.cause).toBe('DATA_UNKNOWN'); // 시세 미확보 — 귀책 미확정
      // **전부 PENDING_REVIEW로 태어난다** — 자동 승인 경로가 없다
      expect(row.status).toBe('PENDING_REVIEW');
      expect(row.executedAt).toBeNull();
    }
  });

  // 구매자는 이미 전액 환불받았다 — 보상은 그것과 **별개의 돈**이라 표가 다르다
  it('구매자 환불(Settlement)과 리서처 보상은 다른 표에 남는다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: CAPPED } });
    const purchases = await prisma.purchase.findMany({ where: { reportId: card.reportId } });
    for (const p of purchases) {
      const st = await prisma.settlement.findUniqueOrThrow({ where: { purchaseId: p.id } });
      expect(st.buyerRefundKrw).toBe(PRICE_KRW); // 전액 환불
      expect(st.researcherPayoutKrw).toBe(0);
      expect(st.platformFeeKrw).toBe(0); // 이 건의 수수료 수익은 0
    }
  });

  it('큐는 카드 단위로 묶어 보여준다 — 같은 질문에 두 번 답하게 하지 않는다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: CAPPED } });
    const queue = await getPendingCompensationReviews(prisma);
    expect(queue).toHaveLength(2); // 닫힌 카드 둘 — 구매 3건이 카드 2줄로 접힌다

    const group = queue.find((g) => g.predictionCardId === card.id)!;
    expect(group.rows).toHaveLength(2);
    expect(group.totalKrw).toBe(
      2 * compensationAmountKrw({ amountKrw: PRICE_KRW, feeRateBp: FEE_RATE_BP }),
    );
    expect(group.causeLabel).toContain('귀책 미확정');
  });
});

describe('사람 확정', () => {
  it('확정 전에는 실행할 수 없다', async () => {
    const row = await prisma.compensationInstruction.findFirstOrThrow({
      where: { status: 'PENDING_REVIEW' },
    });
    await expect(
      executeCompensation(
        prisma,
        { compensationId: row.id, operatorUserId: OPERATOR, bankReference: 'BK-1' },
        PAST_CAP,
      ),
    ).rejects.toThrow(CompensationError);
  });

  // 승인은 규칙의 기본값이지만 **제외는 예외**다 — "왜 이 리서처만 못 받았나"에
  // 답할 문장이 남아야 한다
  it('보상 대상에서 빼려면 사유를 적어야 한다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: CAPPED } });
    await expect(
      reviewCompensation(
        prisma,
        { predictionCardId: card.id, operatorUserId: OPERATOR, decision: 'EXCLUDE' },
        PAST_CAP,
      ),
    ).rejects.toThrow(CompensationError);
  });

  // 2026-08-18 배선 점검 1차: 확정에도 지문이 선다 — 실행에만 걸면 훔친 세션이
  // 승인만 눌러 두는 **잠복 승인**이 남는다 (1인 모드에서는 reviewedBy가 어차피
  // 창업자 계정이라 "이체 대기 목록의 낯선 승인"이 걸러지지 않는다)
  it('1인 모드에서는 지문 표 없이 확정할 수 없다 — 대기 상태는 산다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: CAPPED } });
    await expect(
      reviewCompensation(
        prisma,
        { predictionCardId: card.id, operatorUserId: OPERATOR, decision: 'APPROVE' },
        PAST_CAP,
      ),
    ).rejects.toMatchObject({ code: 'RECHECK_REQUIRED' });
    const rows = await prisma.compensationInstruction.findMany({
      where: { predictionCardId: card.id },
    });
    expect(rows.every((r) => r.status === 'PENDING_REVIEW')).toBe(true);
  });

  it('카드 하나를 확정하면 그 카드의 지시서가 함께 승인된다 — 감사 로그도 한 줄', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: CAPPED } });
    const recheckToken = await issueOperatorRecheck(prisma, OPERATOR, PAST_CAP);
    const count = await reviewCompensation(
      prisma,
      {
        predictionCardId: card.id,
        operatorUserId: OPERATOR,
        decision: 'APPROVE',
        note: '업비트 피드 장애 — 당일 해당 종목 정상 거래 확인',
        recheckToken,
      },
      PAST_CAP,
    );
    expect(count).toBe(2);

    const rows = await prisma.compensationInstruction.findMany({
      where: { predictionCardId: card.id },
    });
    expect(rows.every((r) => r.status === 'APPROVED')).toBe(true);
    expect(rows.every((r) => r.reviewedBy === OPERATOR)).toBe(true);

    const audits = await prisma.auditLog.findMany({
      where: { action: 'COMPENSATION_REVIEWED', targetId: card.id },
    });
    expect(audits).toHaveLength(1);
  });

  it('이미 확정된 카드를 다시 확정할 수 없다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: CAPPED } });
    await expect(
      reviewCompensation(
        prisma,
        { predictionCardId: card.id, operatorUserId: OPERATOR, decision: 'APPROVE' },
        PAST_CAP,
      ),
    ).rejects.toThrow(CompensationError);
  });
});

describe('실행', () => {
  // 계좌이체에는 멱등키가 없다 — 참조번호를 요구하는 것 자체가 운영자를 은행 앱으로
  // 되돌려 보내고, 거기서 이미 보낸 이체가 보인다
  it('은행 이체 참조번호 없이는 실행할 수 없다', async () => {
    const row = await prisma.compensationInstruction.findFirstOrThrow({
      where: { status: 'APPROVED' },
    });
    await expect(
      executeCompensation(
        prisma,
        { compensationId: row.id, operatorUserId: OPERATOR, bankReference: '   ' },
        PAST_CAP,
      ),
    ).rejects.toThrow(CompensationError);
  });

  // 2026-08-18 배선: 보상 실행도 1인 모드의 지문 관문을 지난다 — **플랫폼 자본이
  // 나가는 다섯 번째 길**이라, 이 표가 없으면 비상 복구 뒤 48시간 돈 정지도
  // 이 길만 못 덮는다 (consumeOperatorRecheck 한 점을 지나야 유예가 함께 걸린다)
  it('1인 모드에서는 지문 표 없이 실행할 수 없다 — 승인 상태는 산다', async () => {
    const row = await prisma.compensationInstruction.findFirstOrThrow({
      where: { status: 'APPROVED' },
    });
    await expect(
      executeCompensation(
        prisma,
        { compensationId: row.id, operatorUserId: OPERATOR, bankReference: 'BK-X' },
        PAST_CAP,
      ),
    ).rejects.toMatchObject({ code: 'RECHECK_REQUIRED' });
    const after = await prisma.compensationInstruction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('APPROVED'); // 관문에 막힌 것이지 승인이 죽은 것이 아니다
  });

  it('실행하면 기록·감사·리서처 알림이 함께 남는다', async () => {
    const row = await prisma.compensationInstruction.findFirstOrThrow({
      where: { status: 'APPROVED' },
      orderBy: { id: 'asc' },
    });
    const recheckToken = await issueOperatorRecheck(prisma, OPERATOR, PAST_CAP);
    await executeCompensation(
      prisma,
      {
        compensationId: row.id,
        operatorUserId: OPERATOR,
        bankReference: 'BK-2026-0816-1',
        recheckToken,
      },
      PAST_CAP,
    );

    const after = await prisma.compensationInstruction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('EXECUTED');
    expect(after.executedBy).toBe(OPERATOR);
    expect(after.bankReference).toBe('BK-2026-0816-1');

    expect(
      await prisma.auditLog.count({
        where: { action: 'COMPENSATION_EXECUTED', targetId: row.id },
      }),
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: { userId: researcherUserId, type: 'COMPENSATION_EXECUTED' },
      }),
    ).toBe(1);
  });

  it('같은 건을 두 번 실행할 수 없다', async () => {
    const row = await prisma.compensationInstruction.findFirstOrThrow({
      where: { status: 'EXECUTED' },
    });
    await expect(
      executeCompensation(
        prisma,
        { compensationId: row.id, operatorUserId: OPERATOR, bankReference: 'BK-2' },
        PAST_CAP,
      ),
    ).rejects.toThrow(CompensationError);
  });

  // **돈이 나가는 네 번째 경로다.** 여기 안 세면 일일 한도가 그만큼 헐거워진다 —
  // 벽의 목적이 "오늘 나간 총액"인 이상, 새 경로는 반드시 여기 붙어야 한다
  it('보상도 일일 출금 한도 집계에 들어간다', async () => {
    const executed = await prisma.compensationInstruction.findFirstOrThrow({
      where: { status: 'EXECUTED' },
    });
    const outflow = await todayOutflowKrw(prisma, PAST_CAP);
    expect(outflow).toBeGreaterThanOrEqual(executed.amountKrw);
    expect(await monthCompensatedKrw(prisma, PAST_CAP)).toBe(executed.amountKrw);
  });

  // 일일 한도는 **피해 반경**, 월 예산은 **손실 규모** — 재는 것이 달라 둘 다 지난다
  it('월 보상 예산을 넘으면 실행을 거부한다 — 승인 상태는 그대로 남는다', async () => {
    const row = await prisma.compensationInstruction.findFirstOrThrow({
      where: { status: 'APPROVED' },
    });
    // 예산을 이 건이 반드시 넘도록 낮춰 잡는다 (상수를 손대지 않고 벽만 시험한다)
    await expect(
      (async () => {
        const { assertWithinMonthlyBudget } = await import('../compensationBudget');
        await assertWithinMonthlyBudget(prisma, row.amountKrw, PAST_CAP, 1);
      })(),
    ).rejects.toThrow(CompensationBudgetExceeded);

    // 벽에 막혀도 상태는 APPROVED — 달이 바뀌면 그대로 나간다.
    // (상태로 저장했다면 그 행이 스스로 안 풀려 리서처 돈이 상태값에 갇힌다)
    const after = await prisma.compensationInstruction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('APPROVED');
  });

  it('기본 예산은 초기 규모에서 장애 한 번을 덮는다', () => {
    const perCard = compensationAmountKrw({ amountKrw: 50_000, feeRateBp: FEE_RATE_BP });
    expect(MONTHLY_COMPENSATION_BUDGET_KRW / perCard).toBeGreaterThan(100);
  });
});

// 보상 원장이 만든 새 유인 — 판정 불가가 실패보다 낫고, 점수만 보면 적중보다 안전하다.
// 그러면 **판정되기 어려운 종목을 고를 유인**이 생긴다. 자동 규칙 대신 사람 앞에 놓는다
describe('판정 불가 이력', () => {
  // **구매 건수가 아니라 카드 수다.** 지시서는 구매 1건에 1행이라 그냥 세면
  // 인기 카드 한 장이 다섯 건이 되고, 잘 팔리는 리서처가 그 이유만으로 먼저 걸린다
  it('구매가 아니라 카드를 센다', async () => {
    // CAPPED(구매 2건) + BUDGET(구매 1건) = 지시서 3행이지만 카드는 2장이다
    expect(
      await prisma.compensationInstruction.count({
        where: { researcherUserId, cause: 'DATA_UNKNOWN' },
      }),
    ).toBe(3);
    expect(await countUnjudgeableCards(prisma, researcherUserId, PAST_CAP)).toBe(2);
  });

  // 정지 중 상한·수동 큐 방치·판정 오류는 **리서처가 고른 종목과 아무 관계가 없다.**
  // 그것까지 세면 우리 장애의 대가를 피해자에게 청구하는 규칙이 된다
  it('시세 미확보(DATA_UNKNOWN)만 센다 — 우리 운영 실패는 세지 않는다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: NORMAL } });
    const purchase = await prisma.purchase.findFirstOrThrow({ where: { reportId: card.reportId } });
    await prisma.compensationInstruction.create({
      data: {
        purchaseId: purchase.id,
        predictionCardId: card.id,
        researcherUserId,
        amountKrw: 8_000,
        cause: 'SYSTEM_PAUSE', // 우리가 판정을 멈춰 둔 사이 시한이 지났다
        status: 'PENDING_REVIEW',
        createdAt: PAST_CAP,
      },
    });
    expect(await countUnjudgeableCards(prisma, researcherUserId, PAST_CAP)).toBe(2); // 그대로
    await prisma.compensationInstruction.deleteMany({ where: { cause: 'SYSTEM_PAUSE' } });
  });

  it('창 밖의 이력은 세지 않는다', async () => {
    const wayLater = new Date(PAST_CAP.getTime() + (UNJUDGEABLE_LOOKBACK_DAYS + 1) * 86_400_000);
    expect(await countUnjudgeableCards(prisma, researcherUserId, wayLater)).toBe(0);
  });

  // 판단하는 자리가 여기다 — 숫자만 띄우고 규칙은 만들지 않는다
  it('확정 큐가 그 리서처의 이력을 함께 보여준다', async () => {
    const queue = await getPendingCompensationReviews(prisma, PAST_CAP);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((g) => g.researcherUnjudgeableCards === 2)).toBe(true);
  });
});

describe('확정 대기 큐', () => {
  // 자동 승인 경로를 두지 않은 대가로, 이 큐는 방치되면 리서처 돈이 갇히는 자리가 된다.
  // 사람을 기다리는 큐는 **스스로 소리를 내야 한다**
  it(`${COMPENSATION_REVIEW_OVERDUE_DAYS}일 넘게 확정 안 된 건이 있으면 운영자에게 알린다`, async () => {
    const budgetCard = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: BUDGET } });
    // CAPPED는 앞 시험에서 확정됐고, 확정 안 된 카드는 이것 하나만 남는다
    expect(
      await prisma.compensationInstruction.count({
        where: { predictionCardId: budgetCard.id, status: 'PENDING_REVIEW' },
      }),
    ).toBe(1);

    // 방금 생긴 건은 아직 지연이 아니다
    const fresh = await sweepPendingCompensations(prisma, PAST_CAP);
    expect(fresh.pending).toBe(1);
    expect(fresh.overdue).toBe(0);
    expect(fresh.notified).toBe(false);

    const later = new Date(
      PAST_CAP.getTime() + (COMPENSATION_REVIEW_OVERDUE_DAYS + 1) * 86_400_000,
    );
    const aged = await sweepPendingCompensations(prisma, later);
    expect(aged.overdue).toBe(1);
    expect(aged.notified).toBe(true);
    expect(
      await prisma.notification.count({
        where: { userId: OPERATOR, title: { contains: '귀책 확정' } },
      }),
    ).toBe(1);
  });
});
