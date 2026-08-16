import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedTestInstruments,
  seedVerifiedPayoutAccount,
} from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { getAuditTrail } from '../auditLog';
import { manualJudgeCard } from '../manualJudgmentService';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import { revertJudgment } from '../judgmentRevertService';
import { flushHardCapSurgeAlert, flushOpsAlerts, HIGH_RISK_ACTIONS } from '../opsAlertFeed';
import { DAILY_OUTFLOW_LIMIT_KRW, VelocityLimitExceeded, todayOutflowKrw } from '../payoutVelocity';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import { executePayout } from '../settlementOpsService';
import { SETTLEMENT_COOLDOWN_HOURS } from '../settlementCooldown';

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
// 쿨다운이 끝난 뒤 (settlementCooldown) — **상수에서 유도한다.**
// 시각을 손으로 적으면 쿨다운을 조정할 때마다 무관한 시험이 무더기로 깨진다
const EXEC_NOW = new Date(BATCH_NOW.getTime() + (SETTLEMENT_COOLDOWN_HOURS + 1) * 3_600_000);
// 수동 판정은 시한 경과 7일 뒤부터 허용된다 (자동 판정 우선 — manualJudgmentService)
const MANUAL_NOW = new Date('2026-08-09T00:00:00Z');

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

/** 게시 → 두 사람 구매 → 판정까지 (`skipJudge`면 판정 직전에서 멈춘다) */
async function judgedCard(
  ticker: string,
  close: number,
  opts: { priceKrw?: number; skipJudge?: boolean } = {},
) {
  const { priceKrw = 10_000, skipJudge = false } = opts;
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
  if (!skipJudge) await judgeAndSettleDueCards(prisma, reg, BATCH_NOW, 'CRYPTO');
  const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker } });
  return { cardId: card.id, reportId: draft.id };
}

beforeAll(async () => {
  prisma = createTestDb('audit-log-');
  await seedTestInstruments(
    prisma,
    ['KRW-AU1', 'KRW-AU2', 'KRW-AU3', 'KRW-AU4'].map((ticker) => ({
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
  // 계좌 관문(assertPayoutAccountReady)이 지급 실행 앞에 있다 — 없으면 한 푼도 안 나간다
  await seedVerifiedPayoutAccount(prisma, r.id);
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
  // **평화로울 때 침묵한다.** 자동 판정은 정상 도메인 흐름이라 감사 로그에 들어오지
  // 않는다 — 하루 수백 건이 쌓이면 정작 찾아야 할 개입이 소음에 묻힌다.
  // 타임라인의 첫 줄은 조회 시점에 Judgment 행에서 합쳐 온다(쓰기가 아니라 읽기에서)
  it('자동 판정은 감사 로그에 남지 않고 조회에서 합쳐진다', async () => {
    const { cardId } = await judgedCard('KRW-AU1', 120); // 적중

    expect(await prisma.auditLog.count({ where: { targetId: cardId } })).toBe(0);

    const trail = await getAuditTrail(prisma, 'PredictionCard', cardId);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('AUTO_JUDGMENT');
    expect(trail[0].actorType).toBe('SYSTEM');
    expect(trail[0].derived).toBe(true); // 감사 로그 행이 아니다

    const after = JSON.parse(trail[0].after!);
    expect(after.outcome).toBe('HIT');

    // **스냅샷을 다시 담지 않는다** — 판정 근거는 Judgment.marketSnapshotJson에 이미 있고,
    // 여기 또 넣으면 로그가 검색되지 않는 크기로 자란다
    expect(trail[0].after!.length).toBeLessThan(300);
  });

  // **자르는 선은 행위가 아니라 행위자다.** 같은 Judgment 행을 만들어도 배치가 하면
  // 도메인 흐름이고 사람이 하면 개입이다 — 그리고 탈취된 세션이 돈에 닿는 가장 짧은
  // 길이 "가짜 적중을 매겨 지급 지시서를 만드는 것"이라 알림까지 나가야 한다
  it('수동 판정은 남는다 — 그리고 고위험 알림에 걸린다', async () => {
    const { cardId } = await judgedCard('KRW-AU4', 120, { skipJudge: true });

    await manualJudgeCard(
      prisma,
      {
        cardId,
        operatorUserId: operatorId,
        reason: '공급자 종가 결측 — 거래소 공시로 확인',
        decision: { type: 'UNDECIDABLE', undecidableReason: 'DATA_UNAVAILABLE' },
      },
      MANUAL_NOW,
    );

    const trail = await getAuditTrail(prisma, 'PredictionCard', cardId);
    expect(trail).toHaveLength(1); // 파생 줄이 겹쳐 두 번 그려지지 않는다
    expect(trail[0].action).toBe('MANUAL_JUDGMENT');
    expect(trail[0].actorType).toBe('OPERATOR');
    expect(trail[0].actor).toBe(operatorId); // system: 접두사가 붙지 않는다
    expect(trail[0].derived).toBe(false);

    expect(HIGH_RISK_ACTIONS).toContain('MANUAL_JUDGMENT');
  });

  // "정산 s_1이 왜 생겼나"를 **도메인 외래키를 타고** 찾아온다 —
  // 하위 id를 JSON에 담아 검색하게 만들면 SQLite에는 JSON 인덱스가 없어 풀스캔이 된다
  it('정산에서 출발해 외래키로 이력에 닿는다', async () => {
    const settlement = await prisma.settlement.findFirstOrThrow({
      where: { purchase: { report: { predictionCard: { ticker: 'KRW-AU1' } } } },
      include: {
        purchase: { select: { report: { select: { predictionCard: { select: { id: true } } } } } },
      },
    });

    const cardId = settlement.purchase.report.predictionCard!.id;
    const trail = await getAuditTrail(prisma, 'PredictionCard', cardId);
    expect(trail[0].action).toBe('AUTO_JUDGMENT');
  });

  it('지급 실행이 기록된다 — 실행자·금액·시각', async () => {
    const s = await prisma.settlement.findFirstOrThrow({
      where: { purchase: { report: { predictionCard: { ticker: 'KRW-AU1' } } } },
    });
    await executePayout(
      prisma,
      { settlementId: s.id, operatorUserId: operatorId, confirmedSettled: true },
      EXEC_NOW,
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
    // 판정 행이 지워지면 파생 줄도 함께 사라진다 — 되돌리기 기록이 첫 줄을 물려받는다
    expect(trail.map((t) => t.action)).toEqual(['JUDGMENT_REVERTED']);
    expect(trail[0].reason).toContain('DATA_SOURCE');
    // 판정 행은 지워졌지만 **무엇이 지워졌는지는 남는다**
    expect(JSON.parse(trail[0].before!).judgmentId).toBe(judgment.id);
  });
});

// **하루에 나갈 수 있는 총액을 묶는다.**
// TOTP가 세션 탈취 하나를 막는다면 한도는 원인과 무관하게 **피해의 크기**를 정한다 —
// 세션이 털렸든, 우리 코드 버그든, 운영자 실수든 같은 벽에 부딪힌다
describe('일일 유출 한도', () => {
  it('지급·환불을 합쳐서 센다 — 환불만 열어 두면 에스크로가 통째로 빈다', async () => {
    const before = await todayOutflowKrw(prisma, EXEC_NOW);
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
        EXEC_NOW,
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
        EXEC_NOW,
      ),
    ).rejects.toThrow(/감사 로그/); // 다음에 볼 곳을 알려준다
  });
});

// **고위험 행위는 사람을 찾아간다.**
//
// 감사 로그 전용 화면을 만들려다 접었다 — 1인 운영에서 "운영자 감시 화면"은 아무도
// 자발적으로 열지 않는 죽은 코드가 된다. 대신 사건이 사람을 찾아가게 한다.
//
// **호출부마다 알림을 부르지 않는 것이 핵심이다.** 그러면 여섯 곳 중 한 곳이 반드시
// 빠지고, 빠진 그 한 곳이 공격자가 쓰는 경로가 된다. 감사 로그가 이미 단일 통로이므로
// 거기서 파생시키면 빠질 자리가 없다 — 덤으로 **CLI에서 한 일도 알림이 간다.**
describe('고위험 작업 알림', () => {
  it('처음 돌 때는 과거를 쏟아내지 않는다 — 커서만 세운다', async () => {
    const before = await prisma.notification.count({ where: { type: 'OPS_ALERT' } });
    const r = await flushOpsAlerts(prisma, new Date('2026-08-10T12:00:00Z'));
    expect(r.sent).toBe(0); // 이미 지급·되돌리기가 쌓여 있지만 보내지 않는다
    expect(await prisma.notification.count({ where: { type: 'OPS_ALERT' } })).toBe(before);
  });

  it('커서 이후의 고위험 사건만 보낸다', async () => {
    // 커서 이후에 일어난 사건 하나
    await prisma.auditLog.create({
      data: {
        at: new Date('2026-08-10T13:00:00Z'),
        actor: operatorId,
        actorType: 'OPERATOR',
        action: 'BULK_REVERT',
        targetType: 'JudgmentRange',
        targetId: 'x~y',
        reason: '업비트 종가 오류',
      },
    });
    // 같은 시각의 저위험 사건은 보내지 않는다 — 소음이 되면 진짜 신호도 안 보게 된다
    await prisma.auditLog.create({
      data: {
        at: new Date('2026-08-10T13:01:00Z'),
        actor: 'system:fixture',
        actorType: 'SYSTEM',
        action: 'INSTRUMENT_RISK_SET',
        targetType: 'Instrument',
        targetId: 'noisy',
      },
    });

    const r = await flushOpsAlerts(prisma, new Date('2026-08-10T14:00:00Z'));
    expect(r.sent).toBe(1);

    const n = await prisma.notification.findFirstOrThrow({
      where: { title: { contains: '판정 일괄 되돌리기' } },
    });
    expect(n.body).toContain(operatorId);
    expect(n.body).toContain('업비트 종가 오류');
  });

  it('같은 사건을 두 번 보내지 않는다', async () => {
    const r = await flushOpsAlerts(prisma, new Date('2026-08-10T15:00:00Z'));
    expect(r.sent).toBe(0);
  });
});

// **조용히 대량으로 나가는 환불을 잡는다.**
//
// 상한(14일) 환불은 사람이 실행하는 것이 아니라 시스템이 닫는 것이라 REFUND_EXECUTED
// 감사 기록이 남지 않는다 — 지시서만 만들어진다. 그래서 위의 고위험 알림 경로에
// 걸리지 않고, 회차당 20장씩 매 틱 조금씩 나가면 **총량은 일일 한도 안인데 아무도
// 지금 무슨 일이 벌어지는지 모른다.** 특히 자동 판정을 정지해 둔 동안 이것이
// 유일하게 계속 도는 경로다.
describe('상한 환불 급증 알림', () => {
  const DAY = new Date('2026-08-20T09:00:00Z');

  async function hardCapped(n: number, dataSource: string) {
    for (let i = 0; i < n; i++) {
      const card = await prisma.predictionCard.create({
        data: {
          report: {
            create: {
              researcherId,
              title: `hc-${dataSource}-${i}`,
              summary: 's',
              content: 'c',
              priceKrw: 10_000,
              prepaymentRatio: 0,
              feeRateBp: 2000,
              status: 'CLOSED',
              publishedAt: PUBLISH_NOW,
            },
          },
          assetClass: 'CRYPTO',
          ticker: 'KRW-AU1',
          assetName: 'AU1',
          direction: 'UP',
          targetType: 'RETURN_PCT',
          targetValue: 10,
          confidence: 5,
          selfStability: 5,
          deadline: DEADLINE,
        },
      });
      await prisma.judgment.create({
        data: {
          predictionCardId: card.id,
          outcome: 'UNDECIDABLE',
          undecidableReason: 'DATA_UNAVAILABLE',
          score: 0,
          info: 0,
          dataSource,
          judgedAt: DAY,
        },
      });
    }
  }

  it('문턱 아래에서는 조용하다 — 상한 환불 자체는 정상 경로다', async () => {
    await hardCapped(9, 'hard-cap');
    const r = await flushHardCapSurgeAlert(prisma, DAY);
    expect(r.alerted).toBe(false);
    expect(r.count).toBe(9);
  });

  it('문턱을 넘으면 정지 중 발생분까지 세어 알린다', async () => {
    await hardCapped(3, 'hard-cap:paused');
    const r = await flushHardCapSurgeAlert(prisma, DAY);
    expect(r.alerted).toBe(true);
    expect(r.count).toBe(12);

    const n = await prisma.notification.findFirstOrThrow({
      where: { title: { contains: '상한 환불 급증' } },
    });
    expect(n.body).toContain('12건');
    expect(n.body).toContain('3건은 자동 판정 정지 중'); // 정지를 건 사람에게 그 사실이 돌아간다
  });

  it('같은 날 다시 돌아도 두 번 보내지 않는다 — 매 틱 반복은 그 자체가 소음이다', async () => {
    const before = await prisma.notification.count({
      where: { title: { contains: '상한 환불 급증' } },
    });
    await flushHardCapSurgeAlert(prisma, new Date('2026-08-20T15:00:00Z'));
    expect(
      await prisma.notification.count({ where: { title: { contains: '상한 환불 급증' } } }),
    ).toBe(before);
  });
});
