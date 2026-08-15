import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { getAuditTrail } from '../auditLog';
import {
  BulkRevertRefused,
  executeBulkRevert,
  planBulkRevert,
} from '../bulkRevertService';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { isJudgmentPaused, setJudgmentPause } from '../judgmentPause';
import { purchaseReport } from '../purchaseService';
import { runReachedJudgmentBatch } from '../reachedJudgmentBatch';
import { createDraftReport, publishReport } from '../reportService';

// **시세 공급자가 며칠간 틀린 값을 준 것을 뒤늦게 알았을 때.**
//
// 지금까지는 카드를 한 장씩 되돌리는 것뿐이었다 — 100장이면 100번이고, 사고 상황에서
// 그건 없는 것과 같다.
//
// ── 건수 상한을 두지 않은 이유 ───────────────────────────────
// 외부 검토는 20건 하드 상한을 제안했지만 **정작 이 기능이 필요한 순간이 20건을 넘는
// 순간**이다. 20건씩 다섯 번을 돌리면 그 사이 중간 상태가 실재하고, 판정 배치가 한 번
// 끼어들면 되돌린 카드가 같은 오답으로 다시 판정된다.
// 대신 **절차**로 막는다: 정지가 선행 조건 · 드라이런이 기본 · 시각 구간이 필수.

let prisma: PrismaClient;
let researcherId: string;
let buyerId: string;
let operatorId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');

const FILTER = {
  judgedFrom: new Date('2026-08-01T00:00:00Z'),
  judgedTo: new Date('2026-08-03T00:00:00Z'),
  assetClass: 'CRYPTO' as const,
};

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

async function judgedCard(ticker: string, close: number) {
  const reg = registry(ticker, close);
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
  await publishReport(prisma, reg, draft.id, researcherId, PUBLISH_NOW);
  await purchaseReport(prisma, draft.id, buyerId, PUBLISH_NOW);
  await judgeAndSettleDueCards(prisma, reg, BATCH_NOW, 'CRYPTO');
  return draft.id;
}

beforeAll(async () => {
  prisma = createTestDb('bulk-revert-');
  await seedTestInstruments(
    prisma,
    ['KRW-BR1', 'KRW-BR2', 'KRW-BR3'].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker,
      shortable: true,
    })),
  );
  const r = await prisma.user.create({
    data: { email: 'r@bulk.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@bulk.io', identityVerified: true } })).id;
  operatorId = (
    await prisma.user.create({
      data: { email: 'op@bulk.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;

  await judgedCard('KRW-BR1', 120);
  await judgedCard('KRW-BR2', 120);
  await judgedCard('KRW-BR3', 90); // 실패 → 환불 지시서
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('자동 판정 정지', () => {
  it('멈추면 배치가 한 장도 건드리지 않는다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: operatorId,
      reason: '업비트 종가가 0으로 들어옴',
    });
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(true);

    const due = await judgeAndSettleDueCards(prisma, registry('KRW-BR1', 120), BATCH_NOW, 'CRYPTO');
    expect(due.judged).toBe(0);
    // **도달 판정도 함께 멈춘다** — 되돌리는 사이에 새 판정이 생기면 계획이 도는 동안
    // 대상이 늘어난다
    const reached = await runReachedJudgmentBatch(
      prisma,
      registry('KRW-BR1', 120),
      BATCH_NOW,
      'CRYPTO',
    );
    expect(reached.checked).toBe(0);
  });

  it('다른 자산군은 멈추지 않는다 — 사고를 옆으로 옮기지 않는다', async () => {
    // 국내 공급자가 틀렸는데 코인까지 멈추면 그쪽 카드가 이월되고, 이월은 14일 상한에
    // 닿으면 전액 환불로 끝난다
    expect(await isJudgmentPaused(prisma, 'KR_EQUITY')).toBe(false);
  });

  it('정지·해제는 사유와 함께 감사 로그에 남는다', async () => {
    const trail = await getAuditTrail(prisma, 'JudgmentPause', 'CRYPTO');
    expect(trail[0].action).toBe('JUDGMENT_PAUSE_SET');
    expect(trail[0].reason).toContain('업비트');
    expect(JSON.parse(trail[0].after!).paused).toBe(true);
  });
});

describe('회차 단위 롤백', () => {
  it('드라이런은 아무것도 바꾸지 않고 무엇이 지워질지만 보여준다', async () => {
    const plan = await planBulkRevert(prisma, FILTER);
    expect(plan.items).toHaveLength(3);
    expect(plan.revertable).toBe(3);
    expect(plan.blocked).toBe(0);
    expect(plan.paused).toBe(true);

    // 계획을 세워도 판정은 그대로다
    expect(await prisma.judgment.count()).toBe(3);
  });

  it('돈이 이미 나간 건은 되돌리지 않고 회계 처리로 넘긴다', async () => {
    const s = await prisma.settlement.findFirstOrThrow({
      where: { purchase: { report: { predictionCard: { ticker: 'KRW-BR2' } } } },
    });
    await prisma.settlement.update({
      where: { id: s.id },
      data: { payoutExecutedAt: BATCH_NOW, payoutExecutedBy: operatorId },
    });

    const plan = await planBulkRevert(prisma, FILTER);
    expect(plan.revertable).toBe(2);
    expect(plan.items.find((i) => i.ticker === 'KRW-BR2')?.blockedBy).toContain('지급');
  });

  // **멈추지 않고 되돌리면 되돌릴수록 나빠진다** — 다음 회차가 같은 데이터로 다시
  // 오판정하고, 구매자는 판정이 두 번 뒤집히는 것을 본다
  it('자동 판정이 돌고 있으면 실행을 거부한다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험',
    });

    await expect(
      executeBulkRevert(
        prisma,
        FILTER,
        { operatorUserId: operatorId, reason: '공급자 오류', cause: 'DATA_SOURCE' },
        BATCH_NOW,
      ),
    ).rejects.toBeInstanceOf(BulkRevertRefused);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: operatorId,
      reason: '다시 정지',
    });
  });

  it('되돌릴 수 있는 것만 되돌리고, 나머지는 사유와 함께 남긴다', async () => {
    const r = await executeBulkRevert(
      prisma,
      FILTER,
      { operatorUserId: operatorId, reason: '업비트 종가 오류', cause: 'DATA_SOURCE' },
      BATCH_NOW,
    );

    expect(r.reverted).toHaveLength(2);
    expect(r.needsAccounting).toHaveLength(1);
    expect(r.needsAccounting[0].ticker).toBe('KRW-BR2');
    expect(r.failed).toHaveLength(0);

    // 돈이 나간 건의 판정은 **그대로 남아 있다** — 장부만 되돌리면 DB는 깨끗한데
    // 현실과 다른 최악의 상태가 된다
    expect(await prisma.judgment.count()).toBe(1);

    // 되돌린 카드는 사람 판정 큐로 — 같은 소스는 같은 답을 낸다
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: 'KRW-BR1' } });
    expect(card.manualJudgmentOnly).toBe(true);
  });

  // 카드별 되돌리기도 각자 남지만, "누가 언제 무슨 범위를 한 번에 되돌렸나"는
  // 그 줄들을 모아도 복원되지 않는다
  it('일괄 작업 자체가 한 줄로 남는다', async () => {
    const [log] = await getAuditTrail(
      prisma,
      'JudgmentRange',
      `${FILTER.judgedFrom.toISOString()}~${FILTER.judgedTo.toISOString()}`,
    );
    expect(log.action).toBe('BULK_REVERT');
    const after = JSON.parse(log.after!);
    expect(after.reverted).toBe(2);
    expect(after.needsAccounting).toBe(1);
    expect(after.assetClass).toBe('CRYPTO');
  });
});
