import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { getAuditTrail } from '../auditLog';
import {
  BulkRevertRefused,
  clearManualOnlyForRange,
  executeBulkRevert,
  pauseAndBulkRevert,
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
    ['KRW-BR1', 'KRW-BR2', 'KRW-BR3', 'KRW-BR4', 'KRW-BR5'].map((ticker) => ({
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

// **정지가 만든 결함 — 처음 구현은 정지 중에 상한까지 멈췄다.**
//
// 그러면 정지가 길어지는 동안 시한 후 14일이 지난 카드가 **환불도 못 받고 묶인다.**
// 상한은 판정이 아니라 **구매자와의 약속**이다 — "이 시점까지는 결과를 주거나 돈을
// 돌려준다". 판정을 멈춘 것이 그 약속을 미룰 이유가 되지 못하고, 환불은 고장 난
// 시세를 쓰지 않으므로 멈출 이유도 없다.
//
// (정지 기간을 상한에서 빼는 안은 기각했다 — 플랫폼 사정으로 구매자 돈을 더 묶어
//  두는 것이고, 카드마다 유효 시간이 찢어져 "언제 끝나는가"를 아무도 못 답한다)
describe('정지 중에도 상한은 집행한다', () => {
  const LATE = new Date('2026-08-20T00:00:00Z'); // 시한(8/1)에서 19일 뒤

  it('시한 후 14일이 지난 카드는 정지 중에도 전액 환불로 닫힌다', async () => {
    const reportId = await judgedCard('KRW-BR4', 120);
    // 판정을 지워 "아직 판정 못 한 카드"로 되돌린다 (시세 장애로 이월된 상태)
    await prisma.judgment.deleteMany({
      where: { predictionCard: { ticker: 'KRW-BR4' } },
    });
    await prisma.settlement.deleteMany({ where: { purchase: { reportId } } });
    await prisma.purchase.updateMany({
      where: { reportId },
      data: { escrowStatus: 'HELD' },
    });

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: operatorId,
      reason: '업비트 장애',
    });

    const r = await judgeAndSettleDueCards(prisma, registry('KRW-BR4', 120), LATE, 'CRYPTO');
    expect(r.judged).toBe(1);
    expect(r.hardCapped[0]).toContain('정지 중');

    const j = await prisma.judgment.findFirstOrThrow({
      where: { predictionCard: { ticker: 'KRW-BR4' } },
    });
    expect(j.outcome).toBe('UNDECIDABLE');
    expect(j.dataSource).toBe('hard-cap:paused');
    // **리서처의 적중률은 깎이지 않는다** — 판정 불가는 표본에서 빠진다
    expect(j.score).toBe(0);
    expect(j.info).toBe(0);

    // 구매자는 전액 돌려받는다 — 시한 약속은 정지와 무관하다
    const s = await prisma.settlement.findFirstOrThrow({ where: { purchase: { reportId } } });
    expect(s.buyerRefundKrw).toBe(10_000);
    expect(s.researcherPayoutKrw).toBe(0);
  });

  it('상한에 안 닿은 카드는 정지 중에 건드리지 않는다 — 판정도 환불도 아니다', async () => {
    const reportId = await judgedCard('KRW-BR5', 120);
    await prisma.judgment.deleteMany({ where: { predictionCard: { ticker: 'KRW-BR5' } } });
    await prisma.settlement.deleteMany({ where: { purchase: { reportId } } });
    await prisma.purchase.updateMany({ where: { reportId }, data: { escrowStatus: 'HELD' } });

    // 시한 사흘 뒤 — 아직 상한(14일) 한참 전이다
    const soon = new Date('2026-08-04T00:00:00Z');
    const r = await judgeAndSettleDueCards(prisma, registry('KRW-BR5', 120), soon, 'CRYPTO');
    expect(r.judged).toBe(0);
    expect(await prisma.judgment.count({ where: { predictionCard: { ticker: 'KRW-BR5' } } })).toBe(0);
  });

  // 판정 못 한 원인이 그 종목이 아니라 우리 정지이므로, 멀쩡한 종목이 정지 한 번에
  // 유니버스에서 내려가면 안 된다
  it('정지 중 상한은 종목을 막지 않는다', async () => {
    const inst = await prisma.instrument.findUniqueOrThrow({
      where: { assetClass_ticker: { assetClass: 'CRYPTO', ticker: 'KRW-BR4' } },
    });
    expect(inst.unjudgeableAt).toBeNull();
  });
});

// **멈추고 되돌리는 것은 한 절차다** (2026-08-15, 외부 검토 반영).
//
// 전에는 운영자가 pause를 먼저 치고 와야 했고, 잊으면 거부당했다. 사고 한복판에서
// 명령을 두 번 치게 만들 이유가 없다 — 되돌릴 결심을 한 사람은 이미 "지금 도는
// 판정을 믿을 수 없다"고 판단한 것이라 정지는 그 판단의 따름정리다.
describe('멈추고 되돌린다 — 한 절차', () => {
  it('정지가 안 걸려 있으면 스스로 걸고 진행한다 — 거부하지 않는다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(false);

    const r = await pauseAndBulkRevert(
      prisma,
      FILTER,
      { operatorUserId: operatorId, reason: '공급자 종가 오류', cause: 'DATA_SOURCE' },
      BATCH_NOW,
    );

    expect(r.pausedHere).toBe(true);
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(true);
  });

  // **해제는 따라오지 않는다** — 정지는 이미 내려진 판단의 따름정리지만 해제는
  // 새로운 판단이고, "공급자가 고쳐졌는가"는 밖을 확인하고 온 사람만 답할 수 있다
  it('끝나도 저절로 열리지 않는다', async () => {
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(true);
  });

  it('이미 멈춰 있었으면 그대로 둔다 — 사유를 덮어쓰지 않는다', async () => {
    const r = await pauseAndBulkRevert(
      prisma,
      FILTER,
      { operatorUserId: operatorId, reason: '두 번째', cause: 'DATA_SOURCE' },
      BATCH_NOW,
    );
    expect(r.pausedHere).toBe(false);
  });

  // 범위를 안 좁혔다는 것은 **어느 자산군이 깨졌는지 모른다**는 뜻이다
  it('자산군을 안 좁히면 전역으로 멈춘다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'ALL',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });

    const r = await pauseAndBulkRevert(
      prisma,
      { judgedFrom: FILTER.judgedFrom, judgedTo: FILTER.judgedTo },
      { operatorUserId: operatorId, reason: '어디가 깨졌는지 모름', cause: 'DATA_SOURCE' },
      BATCH_NOW,
    );

    expect(r.pauseScope).toBe('ALL');
    expect(await isJudgmentPaused(prisma, 'KR_EQUITY')).toBe(true); // 안 건드린 자산군도 멈춘다
  });
});

// **되돌린 뒤 자동 판정으로 되돌아가는 길** (리허설이 찾은 두 번째 결함).
//
// 되돌리기는 카드에 `manualJudgmentOnly`를 세워 자동 배치에서 빼는데, 그 표시를 내리는
// 경로가 **어디에도 없었다.** 공급자가 고쳐져도 100장을 한 장씩 손으로 판정하는 것이
// 유일한 길이었고, 그건 되돌리기 자체가 없는 것과 같은 막다른 골목이다.
//
// 이 함수는 **표시만 내린다 — 판정하지 않는다.** 판정은 다음 배치의 몫이고, 그래야
// "지금 시세가 옳은가"의 판단(사람)과 "그 시세로 매기기"(기계)가 갈라진 채로 남는다.
describe('되돌린 카드를 자동 판정으로 되돌린다', () => {
  const CLEAR_RANGE = {
    revertedFrom: new Date('2026-08-01T00:00:00Z'),
    revertedTo: new Date('2026-08-31T00:00:00Z'),
    assetClass: 'CRYPTO' as const,
  };

  it('무엇을 확인했는지 안 적으면 거부한다 — 정지 해제와 같은 판단이다', async () => {
    await expect(
      clearManualOnlyForRange(prisma, CLEAR_RANGE, { operatorUserId: operatorId, reason: '  ' }),
    ).rejects.toBeInstanceOf(BulkRevertRefused);
  });

  it('표시를 내리고 백오프도 함께 지운다 (되돌아온 카드가 하루를 더 기다리지 않게)', async () => {
    const before = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: 'KRW-BR1' } });
    expect(before.manualJudgmentOnly).toBe(true);

    const r = await clearManualOnlyForRange(prisma, CLEAR_RANGE, {
      operatorUserId: operatorId,
      reason: '업비트 종가가 정정된 것을 확인했습니다',
    });
    expect(r.cardIds).toContain(before.id);

    const after = await prisma.predictionCard.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.manualJudgmentOnly).toBe(false);
    expect(after.deferCount).toBe(0);
    expect(after.nextAttemptAt).toBeNull();
    // **판정하지는 않았다** — 표시를 내리는 것과 다시 매기는 것은 다른 결정이다
    expect(await prisma.judgment.findUnique({ where: { predictionCardId: before.id } })).toBeNull();
  });

  it('두 번 돌려도 아무 일도 없다 (이미 내려간 표시를 다시 내리지 않는다)', async () => {
    const r = await clearManualOnlyForRange(prisma, CLEAR_RANGE, {
      operatorUserId: operatorId,
      reason: '재실행',
    });
    expect(r.cleared).toBe(0);
  });
});
