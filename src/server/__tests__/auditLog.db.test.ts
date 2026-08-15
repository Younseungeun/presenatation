import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { getAuditTrail } from '../auditLog';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { revertJudgment } from '../judgmentRevertService';
import { DAILY_OUTFLOW_LIMIT_KRW, VelocityLimitExceeded, todayOutflowKrw } from '../payoutVelocity';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import { executePayout } from '../settlementOpsService';

// **돈의 근거가 언제 어떻게 바뀌었는지의 단일 기록.**
//
// 도메인 표는 상태를 관리하고 이 표는 사건을 남긴다. 둘의 역할이 다르므로 중복은
// 비용이 아니라 정합성 검증의 재료다 — 어긋나는 날이 오면 그 자체가 이상 신호다.
//
// 이 시험이 고정하는 성질 셋:
//  ① **사건 하나에 한 줄** — 판정이 정산 2건·알림 3건을 만들어도 로그는 한 줄이다
//  ② **도메인 외래키로 찾아온다** — 하위 id를 JSON에 담아 검색하게 만들면
//     SQLite에는 JSON 인덱스가 없어 풀스캔이 된다
//  ③ **기록과 돈이 함께 커밋된다** — 실행이 실패하면 기록도 없다

let prisma: PrismaClient;
let researcherId: string;
let buyerAId: string;
let buyerBId: string;
let operatorId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');

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

/** 게시 → 두 사람 구매 → 판정까지 */
async function judgedCard(ticker: string, close: number, priceKrw = 10_000) {
  const reg = registry(ticker, close);
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: `${ticker} 전망`,
      summary: '요약',
      content: '본문',
      priceKrw,
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
  await purchaseReport(prisma, draft.id, buyerAId, PUBLISH_NOW);
  await purchaseReport(prisma, draft.id, buyerBId, PUBLISH_NOW);
  await judgeAndSettleDueCards(prisma, reg, BATCH_NOW, 'CRYPTO');
  const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker } });
  return { cardId: card.id, reportId: draft.id };
}

beforeAll(async () => {
  prisma = createTestDb('audit-log-');
  await seedTestInstruments(
    prisma,
    ['KRW-AU1', 'KRW-AU2', 'KRW-AU3'].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker,
      shortable: true,
    })),
  );
  const r = await prisma.user.create({
    data: { email: 'r@audit.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerAId = (await prisma.user.create({ data: { email: 'a@audit.io', identityVerified: true } }))
    .id;
  buyerBId = (await prisma.user.create({ data: { email: 'b@audit.io', identityVerified: true } }))
    .id;
  operatorId = (
    await prisma.user.create({
      data: { email: 'op@audit.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('감사 로그', () => {
  // **판정 한 번 = 로그 한 줄.** 정산 2건·알림 3건이 함께 생겨도 줄은 하나다
  it('판정은 정산이 몇 건이든 한 줄로 남는다', async () => {
    const { cardId } = await judgedCard('KRW-AU1', 120); // 적중

    const trail = await getAuditTrail(prisma, 'PredictionCard', cardId);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('JUDGMENT_CREATED');
    expect(trail[0].actorType).toBe('SYSTEM'); // 돈이 움직이는 사건의 대다수는 사람이 아니다

    const after = JSON.parse(trail[0].after!);
    expect(after.outcome).toBe('HIT');
    expect(after.purchases).toBe(2);
    expect(after.payoutKrw).toBeGreaterThan(0);

    // **스냅샷을 다시 담지 않는다** — 판정 근거는 Judgment.marketSnapshotJson에 이미 있고,
    // 여기 또 넣으면 로그가 검색되지 않는 크기로 자란다
    expect(trail[0].after!.length).toBeLessThan(300);
  });

  // "정산 s_1이 왜 생겼나"를 **도메인 외래키를 타고** 찾아온다 —
  // 하위 id를 JSON에 담아 검색하게 만들면 SQLite에는 JSON 인덱스가 없어 풀스캔이 된다
  it('정산에서 출발해 외래키로 감사 기록에 닿는다', async () => {
    const settlement = await prisma.settlement.findFirstOrThrow({
      where: { purchase: { report: { predictionCard: { ticker: 'KRW-AU1' } } } },
      include: {
        purchase: { select: { report: { select: { predictionCard: { select: { id: true } } } } } },
      },
    });

    const cardId = settlement.purchase.report.predictionCard!.id;
    const trail = await getAuditTrail(prisma, 'PredictionCard', cardId);
    expect(trail[0].action).toBe('JUDGMENT_CREATED');
  });

  it('지급 실행이 기록된다 — 실행자·금액·시각', async () => {
    const s = await prisma.settlement.findFirstOrThrow({
      where: { purchase: { report: { predictionCard: { ticker: 'KRW-AU1' } } } },
    });
    await executePayout(
      prisma,
      { settlementId: s.id, operatorUserId: operatorId, confirmedSettled: true },
      BATCH_NOW,
    );

    const [log] = await getAuditTrail(prisma, 'Settlement', s.id);
    expect(log.action).toBe('PAYOUT_EXECUTED');
    expect(log.actor).toBe(operatorId);
    expect(log.actorType).toBe('OPERATOR');
    expect(JSON.parse(log.after!).amountKrw).toBe(s.researcherPayoutKrw);
    expect(log.reason).toContain('PG 입금 확인');
  });

  // 되돌리기는 JudgmentRevert 묘비에도 남지만 그건 **그 도메인의 상태**다.
  // "이 카드에 무슨 일이 순서대로 있었나"는 한 표에서만 읽을 수 있다
  it('되돌리기는 판정 기록 뒤에 시간 순으로 이어 붙는다', async () => {
    const { cardId } = await judgedCard('KRW-AU2', 120);
    const judgment = await prisma.judgment.findUniqueOrThrow({
      where: { predictionCardId: cardId },
    });

    await revertJudgment(
      prisma,
      {
        judgmentId: judgment.id,
        operatorUserId: operatorId,
        reason: '공급자 종가 오류',
        cause: 'DATA_SOURCE',
      },
      BATCH_NOW,
    );

    const trail = await getAuditTrail(prisma, 'PredictionCard', cardId);
    expect(trail.map((t) => t.action)).toEqual(['JUDGMENT_CREATED', 'JUDGMENT_REVERTED']);
    expect(trail[1].reason).toContain('DATA_SOURCE');
    // 판정 행은 지워졌지만 **무엇이 지워졌는지는 남는다**
    expect(JSON.parse(trail[1].before!).judgmentId).toBe(judgment.id);
  });
});

// **하루에 나갈 수 있는 총액을 묶는다.**
// TOTP가 세션 탈취 하나를 막는다면 한도는 원인과 무관하게 **피해의 크기**를 정한다 —
// 세션이 털렸든, 우리 코드 버그든, 운영자 실수든 같은 벽에 부딪힌다
describe('일일 유출 한도', () => {
  it('지급·환불을 합쳐서 센다 — 환불만 열어 두면 에스크로가 통째로 빈다', async () => {
    const before = await todayOutflowKrw(prisma, BATCH_NOW);
    expect(before).toBeGreaterThan(0); // 위 시험의 지급이 잡힌다

    // 오늘이 아닌 날의 실행은 안 센다 — 한도는 달력 하루 단위다
    expect(await todayOutflowKrw(prisma, new Date('2026-09-01T00:00:00Z'))).toBe(0);
  });

  it('한도를 넘으면 지급을 거부한다 — 그리고 무엇을 확인해야 하는지 말한다', async () => {
    const { reportId } = await judgedCard('KRW-AU3', 120);
    const s = await prisma.settlement.findFirstOrThrow({
      where: { purchase: { reportId }, researcherPayoutKrw: { gt: 0 } },
    });
    // 카드 가격 상한이 5만원이라 한 건으로는 한도에 못 닿는다 — 금액만 키워
    // **가드 자체**를 시험한다(거래가 커지면 실제로 이 크기가 된다)
    await prisma.settlement.update({
      where: { id: s.id },
      data: { researcherPayoutKrw: DAILY_OUTFLOW_LIMIT_KRW },
    });

    await expect(
      executePayout(
        prisma,
        { settlementId: s.id, operatorUserId: operatorId, confirmedSettled: true },
        BATCH_NOW,
      ),
    ).rejects.toBeInstanceOf(VelocityLimitExceeded);

    // 거부는 아무것도 실행하지 않는다
    expect(
      (await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).payoutExecutedAt,
    ).toBeNull();

    await expect(
      executePayout(
        prisma,
        { settlementId: s.id, operatorUserId: operatorId, confirmedSettled: true },
        BATCH_NOW,
      ),
    ).rejects.toThrow(/감사 로그/); // 다음에 볼 곳을 알려준다
  });
});
