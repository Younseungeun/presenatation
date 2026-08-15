import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { DailyQuote, ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  emptyRangeAlerts,
  EMPTY_RANGE_MIN_CARDS,
  EMPTY_RANGE_STREAK,
  JUDGMENT_HARD_CAP_DAYS,
  JUDGMENT_ABSOLUTE_CAP_DAYS,
  judgeAndSettleDueCards,
  shouldHaltOnDisagreement,
  DISAGREEMENT_HALT_MIN,
} from '../judgmentBatch';
import { writeRecovery } from '../recoveryState';
import { createDraftReport, publishReport } from '../reportService';
import { manualJudgeCard } from '../manualJudgmentService';
import {
  isJudgmentPaused,
  resumeIfSystemPaused,
  setJudgmentPause,
  SYSTEM_PAUSE_ACTOR,
} from '../judgmentPause';
import {
  nextProbeAt,
  probeAndMaybeResume,
  beginRecovery,
  sourceInstabilityVerdict,
  HARD_LOCK_GRACE_MS,
  PAUSE_GRACE_MS,
  PROBE_MAX_FAILURES,
} from '../crossCheckRecovery';

// **두 시세 소스가 다른 답을 냈을 때 무엇이 일어나는가** (domain/crossCheck).
//
// 지키려는 것 넷:
//  ① shadow에서는 아무것도 막지 않는다 — 검증 안 된 소스가 정산을 멈추면 안 된다
//  ② enforce에서는 판정하지 않고 **곧장 수동 큐**로 간다 (이월 사다리를 타지 않는다:
//     기다림이 아무것도 바꾸지 않아 결말이 "판정 불가·전액 환불"로 정해져 있다)
//  ③ 수동 큐에 올린 카드도 **즉시 판정할 수 있어야 한다** — 자동 판정이 꺼진 카드에
//     "자동 판정 우선 7일"을 적용하면 우선권을 줄 상대가 없는 대기가 된다
//  ④ 그래도 **상한은 살아 있다** — 사람에게 넘기는 것과 구매자를 무기한 기다리게 하는
//     것은 다르다. 시한 후 14일이면 시스템이 전액 환불로 닫는다

let prisma: PrismaClient;
let researcherId: string;
let operatorId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');
/** 시한 후 상한을 넘긴 시각 */
const PAST_CAP = new Date(DEADLINE.getTime() + (JUDGMENT_HARD_CAP_DAYS + 1) * 86_400_000);

function bar(date: string, close: number): DailyQuote {
  return { date, open: close, high: close, low: close, close, volume: 1 };
}

/** 기준가 100 · 목표 +20% → 목표선은 120. close로 적중/실패를 마음대로 만든다 */
function sourceAt(ticker: string, close: number, sourceId?: string): ProviderRegistry {
  const p = new FixtureMarketDataProvider();
  if (sourceId) (p as { sourceId: string }).sourceId = sourceId;
  p.setCurrentPrice(ticker, 100).setQuotes(ticker, [
    bar('2026-07-20', 100),
    bar('2026-08-01', close),
  ]);
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
      priceKrw: 10_000,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker,
        assetName: ticker,
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 30,
        confidence: 5,
        selfStability: 5,
        deadline: DEADLINE,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, sourceAt(ticker, 100), draft.id, researcherId, PUBLISH_NOW);
  return draft.id;
}

const HIT_CLOSE = 135; // 기준가 100 · 목표 +30% → 130 위
const MISS_CLOSE = 125;

beforeAll(async () => {
  prisma = createTestDb('judge-xcheck-');
  await seedTestInstruments(
    prisma,
    ['KRW-XC1', 'KRW-XC2', 'KRW-XC3', 'KRW-XC4'].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker,
      shortable: true,
    })),
  );
  const u = await prisma.user.create({
    data: {
      email: 'r@xcheck.io',
      identityVerified: true,
      researcherProfile: { create: { tier: 'CHALLENGER' } },
    },
    include: { researcherProfile: true },
  });
  researcherId = u.researcherProfile!.id;
  const op = await prisma.user.create({
    data: { email: 'op@xcheck.io', identityVerified: true, role: 'OPERATOR' },
  });
  operatorId = op.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('교차검증 — shadow는 막지 않는다', () => {
  it('결론이 갈려도 주 소스대로 판정하고 감사에 사실만 남긴다', async () => {
    const reportId = await publishCard('KRW-XC1');
    const summary = await judgeAndSettleDueCards(
      prisma,
      sourceAt('KRW-XC1', HIT_CLOSE),
      BATCH_NOW,
      'CRYPTO',
      undefined,
      undefined,
      sourceAt('KRW-XC1', MISS_CLOSE, 'second'),
      'shadow',
    );
    expect(summary.judged).toBe(1);
    expect(summary.disagreed).toHaveLength(0);

    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { reportId },
      include: { judgment: true },
    });
    expect(card.judgment!.outcome).toBe('HIT');
    expect(card.manualJudgmentOnly).toBe(false);
    const snap = JSON.parse(card.judgment!.marketSnapshotJson ?? '{}') as {
      crossCheck?: { status: string; sourceId: string };
    };
    expect(snap.crossCheck?.status).toBe('DISAGREED');
    expect(snap.crossCheck?.sourceId).toBe('second');
  });
});

describe('교차검증 — enforce는 판정하지 않고 사람에게 넘긴다', () => {
  it('이월 사다리를 타지 않고 곧장 수동 판정 큐로 간다', async () => {
    const reportId = await publishCard('KRW-XC2');
    const summary = await judgeAndSettleDueCards(
      prisma,
      sourceAt('KRW-XC2', HIT_CLOSE),
      BATCH_NOW,
      'CRYPTO',
      undefined,
      undefined,
      sourceAt('KRW-XC2', MISS_CLOSE, 'second'),
      'enforce',
    );
    expect(summary.judged).toBe(0);
    expect(summary.disagreed).toHaveLength(1);
    // **이월도 실패도 아니다** — 백오프를 태우면 결말이 전액 환불로 정해져 버린다
    expect(summary.deferred).toBe(0);
    expect(summary.failed).toBe(0);

    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    expect(card.manualJudgmentOnly).toBe(true);
    expect(card.deferCount).toBe(0);
  });

  it('수동 큐에 올린 카드는 7일을 기다리지 않고 바로 판정할 수 있다', async () => {
    const reportId = await publishCard('KRW-XC3');
    await judgeAndSettleDueCards(
      prisma,
      sourceAt('KRW-XC3', HIT_CLOSE),
      BATCH_NOW,
      'CRYPTO',
      undefined,
      undefined,
      sourceAt('KRW-XC3', MISS_CLOSE, 'second'),
      'enforce',
    );
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });

    // BATCH_NOW는 시한 후 하루 — 원래라면 "자동 판정 우선 7일"에 막힌다.
    // 자동 판정이 꺼진 카드에는 그 우선권을 줄 상대가 없다
    await manualJudgeCard(
      prisma,
      {
        cardId: card.id,
        operatorUserId: operatorId,
        reason: '두 소스 대조 결과 주 소스가 맞았습니다',
        decision: { type: 'PRICE', priceAtDeadline: HIT_CLOSE },
      },
      BATCH_NOW,
    );
    const judged = await prisma.judgment.findUniqueOrThrow({
      where: { predictionCardId: card.id },
    });
    expect(judged.outcome).toBe('HIT');
  });
});

describe('수동 큐에 있어도 상한은 살아 있다', () => {
  it('아무도 손대지 않은 채 14일이 지나면 시스템이 전액 환불로 닫는다', async () => {
    const reportId = await publishCard('KRW-XC4');
    await judgeAndSettleDueCards(
      prisma,
      sourceAt('KRW-XC4', HIT_CLOSE),
      BATCH_NOW,
      'CRYPTO',
      undefined,
      undefined,
      sourceAt('KRW-XC4', MISS_CLOSE, 'second'),
      'enforce',
    );
    const before = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    expect(before.manualJudgmentOnly).toBe(true);

    // 상한 이후의 회차 — 이 카드는 자동 조회에서 빠져 있어 예전에는 **영원히 묶였다**
    const summary = await judgeAndSettleDueCards(
      prisma,
      sourceAt('KRW-XC4', HIT_CLOSE),
      PAST_CAP,
      'CRYPTO',
    );
    expect(summary.hardCapped.some((s) => s.includes('수동 큐에서'))).toBe(true);

    const judgment = await prisma.judgment.findUniqueOrThrow({
      where: { predictionCardId: before.id },
    });
    expect(judgment.outcome).toBe('UNDECIDABLE');
    expect(judgment.undecidableReason).toBe('DATA_UNAVAILABLE');
    expect(judgment.dataSource).toBe('hard-cap:manual-only');
  });
});

describe('emptyRangeAlerts — 비율만으로도 건수만으로도 판단하지 않는다', () => {
  const stat = (attempted: number, empty: number, stuckTickers: string[] = []) => ({
    attempted,
    empty,
    stuckTickers,
  });

  it('비율은 높아도 건수가 적으면 울리지 않는다 (조용한 날 2/2 = 100%)', () => {
    expect(emptyRangeAlerts(new Map([['kis', stat(2, 2)]]))).toHaveLength(0);
  });

  it('건수는 많아도 비율이 낮으면 울리지 않는다', () => {
    expect(emptyRangeAlerts(new Map([['kis', stat(1000, 50)]]))).toHaveLength(0);
  });

  it('비율과 건수를 둘 다 넘으면 대량 알림', () => {
    const [alert] = emptyRangeAlerts(
      new Map([['kis', stat(EMPTY_RANGE_MIN_CARDS * 2, EMPTY_RANGE_MIN_CARDS * 2)]]),
    );
    expect(alert.bulk).toBe(true);
    expect(alert.sourceId).toBe('kis');
  });

  it('비율에 안 걸려도 같은 종목이 반복해 비면 이름을 올린다', () => {
    const [alert] = emptyRangeAlerts(new Map([['kis', stat(1000, 3, ['005930'])]]));
    expect(alert.bulk).toBe(false);
    expect(alert.stat.stuckTickers).toEqual(['005930']);
  });
});

describe('빈 배열은 배치에서 따로 세어진다', () => {
  it(`분모(시도)와 함께 세고, ${EMPTY_RANGE_STREAK}회 반복 종목을 따로 모은다`, async () => {
    const empty: ProviderRegistry = { CRYPTO: new FixtureMarketDataProvider() };
    // 이 회차 대상은 앞 시험들이 다 처리해 남은 것이 없어야 한다 — 새 카드를 하나 낸다
    await publishCard('KRW-XC1'); // 같은 종목의 두 번째 카드
    const summary = await judgeAndSettleDueCards(prisma, empty, BATCH_NOW, 'CRYPTO');
    const stat = summary.emptyRange.get('fixture');
    expect(stat).toBeDefined();
    expect(stat!.empty).toBeGreaterThan(0);
    expect(stat!.attempted).toBeGreaterThanOrEqual(stat!.empty);
  });
});

// **불일치가 무더기면 자산군을 통째로 세운다** (2026-08-15, 외부 검토 D-4).
//
// 전에는 "예상 불일치가 운영자 용량을 넘으면 enforce로 올리지 않는다"를 전환 조건에
// 뒀는데, 안전 장치의 방향이 거꾸로였다 — **불일치가 폭증하는 바로 그날 대조가 꺼지고**
// 신뢰가 깨진 단일 소스로 자동 판정이 그대로 나간다. 용량 초과의 처방은 장치를 끄는
// 것이 아니라 큐를 세우는 것이다.
describe('대량 불일치 → 자동 판정 정지', () => {
  it('문턱은 비율과 건수를 둘 다 넘어야 한다', () => {
    // 조용한 날의 2/2 = 100% — 세우면 안 된다
    expect(shouldHaltOnDisagreement(2, 2)).toBe(false);
    // 만기가 몰린 날의 몇 건 — 나머지가 멀쩡하면 수동 큐로 보내고 지나간다
    expect(shouldHaltOnDisagreement(4, 100)).toBe(false);
    expect(shouldHaltOnDisagreement(DISAGREEMENT_HALT_MIN, DISAGREEMENT_HALT_MIN * 2)).toBe(true);
  });

  it('한 회차에서 무더기로 갈리면 그 자산군의 자동 판정이 선다', async () => {
    const tickers = ['KRW-HL1', 'KRW-HL2', 'KRW-HL3', 'KRW-HL4', 'KRW-HL5', 'KRW-HL6'];
    await seedTestInstruments(
      prisma,
      tickers.map((ticker) => ({ assetClass: 'CRYPTO', ticker, name: ticker, shortable: true })),
    );
    // 활성 카드 상한에 걸리지 않게 리서처를 나눈다
    const ids: string[] = [];
    for (const [i] of tickers.entries()) {
      const u = await prisma.user.create({
        data: {
          email: `halt${i}@xcheck.io`,
          identityVerified: true,
          researcherProfile: { create: { tier: 'CHALLENGER' } },
        },
        include: { researcherProfile: true },
      });
      ids.push(u.researcherProfile!.id);
    }
    const saved = researcherId;
    for (const [i, t] of tickers.entries()) {
      researcherId = ids[i];
      await publishCard(t);
    }
    researcherId = saved;

    // 주 소스는 전부 적중, 두 번째 소스는 전부 실패 → 전원 불일치
    const primary = new FixtureMarketDataProvider();
    const second = new FixtureMarketDataProvider();
    (second as { sourceId: string }).sourceId = 'second';
    for (const t of tickers) {
      primary.setCurrentPrice(t, 100).setQuotes(t, [bar('2026-07-20', 100), bar('2026-08-01', HIT_CLOSE)]);
      second.setCurrentPrice(t, 100).setQuotes(t, [bar('2026-07-20', 100), bar('2026-08-01', MISS_CLOSE)]);
    }

    const summary = await judgeAndSettleDueCards(
      prisma,
      { CRYPTO: primary },
      BATCH_NOW,
      'CRYPTO',
      undefined,
      undefined,
      { CRYPTO: second },
      'enforce',
    );

    expect(summary.disagreed.length).toBeGreaterThanOrEqual(DISAGREEMENT_HALT_MIN);
    expect(summary.haltedAssetClasses).toEqual(['CRYPTO']);
    // **다음 회차는 실제로 선다** — 정지가 기록으로만 남으면 아무것도 막지 못한다
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(true);

    // 정지 중에도 상한(환불)은 계속 집행된다 — 구매자 약속은 정지와 무관하다
    const during = await judgeAndSettleDueCards(prisma, { CRYPTO: primary }, PAST_CAP, 'CRYPTO');
    expect(during.hardCapped.length).toBeGreaterThan(0);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });
});

// **정지가 스스로 풀릴 수 있어야 한다** (2026-08-15, 외부 검토 D-4).
//
// 완전 수동 해제는 단일 고장점이다 — 순간 단절로 멈춘 자산군이 운영자 휴가 때문에
// 며칠 서 있으면 맞힌 카드까지 14일 상한에 닿아 전액 환불로 끝난다.
//
// 다만 검토의 제안("정지 후 불일치율이 0%면 해제")은 그대로는 성립하지 않는다:
// 정지 중에는 배치가 진입부에서 돌아가므로 **관측할 기회 자체가 없다.** 0%는
// "괜찮아졌다"가 아니라 "아무것도 안 쟀다"다. 그래서 쓰지 않는 탐침을 따로 돌린다.
describe('정지 자동 해제 — 탐침', () => {
  const PROBE_TICKER = 'KRW-PB1';

  async function pauseBySystem(now = BATCH_NOW) {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: '시험: 시스템 정지',
    });
    // 배치가 정지할 때 하는 일 — 지난 사고의 표적·실패 횟수를 지운다
    await beginRecovery(prisma, 'CRYPTO', [], now);
  }

  it('사람이 건 정지는 건드리지 않는다 — 기계가 사람의 판단을 뒤집지 않는다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: operatorId,
      reason: '시험: 사람 정지',
    });
    const r = await probeAndMaybeResume(
      prisma,
      sourceAt(PROBE_TICKER, HIT_CLOSE),
      'CRYPTO',
      sourceAt(PROBE_TICKER, HIT_CLOSE, 'second'),
      BATCH_NOW,
      'enforce',
    );
    expect(r.resumed).toBe(false);
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(true);
  });

  it('확인할 카드가 없으면 판단하지 않는다 — "불일치 0"이 "안 쟀다"인 경우', async () => {
    await pauseBySystem();
    // 이 시점에 CRYPTO 미판정·시한 도래 카드는 앞 시험들이 모두 소진했다
    const r = await probeAndMaybeResume(
      prisma,
      sourceAt('KRW-NONE', HIT_CLOSE),
      'CRYPTO',
      sourceAt('KRW-NONE', HIT_CLOSE, 'second'),
      BATCH_NOW,
      'enforce',
    );
    expect(r.checked).toBe(0);
    expect(r.resumed).toBe(false);
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(true);
  });

  it('두 소스가 다시 일치하면 풀고, 탐침은 아무것도 쓰지 않는다', async () => {
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker: PROBE_TICKER, name: PROBE_TICKER, shortable: true },
    ]);
    // 정지를 풀어 둔 상태에서 카드를 낸 뒤 다시 시스템 정지를 건다
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });
    const reportId = await publishCard(PROBE_TICKER);
    await pauseBySystem();

    const r = await probeAndMaybeResume(
      prisma,
      sourceAt(PROBE_TICKER, HIT_CLOSE),
      'CRYPTO',
      sourceAt(PROBE_TICKER, HIT_CLOSE, 'second'),
      BATCH_NOW,
      'enforce',
    );
    expect(r.checked).toBeGreaterThan(0);
    expect(r.disagreed).toBe(0);
    expect(r.resumed).toBe(true);
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(false);

    // **탐침은 판정하지 않는다** — 쓰는 순간 "정지 중"이라는 상태가 거짓이 된다
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    expect(await prisma.judgment.findUnique({ where: { predictionCardId: card.id } })).toBeNull();
    expect(card.deferCount).toBe(0);
  });

  it('계속 갈리면 실패를 세다가 자동 재개를 포기한다', async () => {
    await pauseBySystem();
    let last = await probeAndMaybeResume(
      prisma,
      sourceAt(PROBE_TICKER, HIT_CLOSE),
      'CRYPTO',
      sourceAt(PROBE_TICKER, MISS_CLOSE, 'second'),
      BATCH_NOW,
      'enforce',
    );
    expect(last.disagreed).toBeGreaterThan(0);
    expect(last.resumed).toBe(false);

    for (let i = 1; i < PROBE_MAX_FAILURES; i++) {
      last = await probeAndMaybeResume(
        prisma,
        sourceAt(PROBE_TICKER, HIT_CLOSE),
        'CRYPTO',
        sourceAt(PROBE_TICKER, MISS_CLOSE, 'second'),
        new Date(BATCH_NOW.getTime() + i * 60 * 60_000),
        'enforce',
      );
    }
    expect(last.hardLocked).toBe(true);
    // 포기한 뒤에는 더 두드리지 않는다 — 공급자 호출만 태우고 개입을 늦춘다
    const after = await probeAndMaybeResume(
      prisma,
      sourceAt(PROBE_TICKER, HIT_CLOSE),
      'CRYPTO',
      sourceAt(PROBE_TICKER, HIT_CLOSE, 'second'),
      new Date(BATCH_NOW.getTime() + 99 * 60 * 60_000),
      'enforce',
    );
    expect(after.hardLocked).toBe(true);
    expect(after.checked).toBe(0);
    expect(after.resumed).toBe(false);
  });
});

// **정지가 재기동 한 번으로 풀리면 안 된다** (2026-08-15).
//
// `isJudgmentPaused(prisma, undefined)`는 전역 정지만 본다. 그래서 기동 따라잡기와
// `npm run batch:judge`가 자산군별 정지를 통째로 무시하고 있었다 — 사고가 나서
// 멈췄는데 **그 사고를 고치려고 배포하면 정지가 풀리는** 모양이었다.
describe('스코프 없는 배치도 자산군 정지를 존중한다', () => {
  it('정지된 자산군의 카드는 전 자산군 배치에서도 잡히지 않는다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });
    const reportId = await publishCard('KRW-XC2'); // 같은 종목의 새 카드
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: operatorId,
      reason: '시험: 자산군 정지',
    });

    // 스코프 **없이** 돈다 — 예전에는 여기서 그대로 판정됐다
    const summary = await judgeAndSettleDueCards(prisma, sourceAt('KRW-XC2', HIT_CLOSE), BATCH_NOW);
    expect(summary.judged).toBe(0);

    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    expect(await prisma.judgment.findUnique({ where: { predictionCardId: card.id } })).toBeNull();

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });
});

// **탐침은 백오프를 탄다** (2026-08-15, 외부 검토 E-1).
//
// 검토의 전제("배치가 1분마다 돌아 6분 만에 포기한다")는 사실과 달랐다 — 판정은
// enqueueDaily라 자산군당 하루 한 번이다. 그런데 그 사실이 결함을 **반대 방향으로**
// 드러냈다: 탐침을 판정 경로에 두면 관측도 하루 한 번이라, 10분짜리 순간 단절로
// 멈춘 자산군이 꼬박 하루를 서 있고 6회 실패에 6일이 걸린다.
//
// → 탐침을 판정 일정에서 떼어 틱(1분)마다 자격만 보게 하고, 실제 주기는 백오프가
// 정한다. 그러면 검토가 제안한 눈금(0·2·4·8·16·32분)이 그대로 의미를 갖는다.
describe('탐침 백오프', () => {
  it('실패할수록 다음 탐침이 뒤로 밀린다', () => {
    const t0 = new Date('2026-08-02T00:00:00Z');
    const mins = (d: Date) => (d.getTime() - t0.getTime()) / 60_000;
    expect(mins(nextProbeAt(0, t0))).toBe(0);
    expect(mins(nextProbeAt(1, t0))).toBe(2);
    expect(mins(nextProbeAt(3, t0))).toBe(8);
    // 마지막 눈금을 반복하지 않는다 — 그 지점에서 자동 재개를 포기하기 때문이다
    expect(mins(nextProbeAt(PROBE_MAX_FAILURES - 1, t0))).toBe(32);
    expect(mins(nextProbeAt(99, t0))).toBe(32);
  });

  it('백오프 시각 전에는 두드리지 않고, 그것은 실패가 아니다', async () => {
    const BACKOFF_TICKER = 'KRW-BO1';
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker: BACKOFF_TICKER, name: BACKOFF_TICKER, shortable: true },
    ]);
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });
    await publishCard(BACKOFF_TICKER);
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: '시험: 백오프',
    });
    await beginRecovery(prisma, 'CRYPTO', [], BATCH_NOW); // 새 사고 — 배치가 정지할 때 하는 일

    // 1회차 — 갈린다 → 실패 1, 다음 탐침은 2분 뒤
    const first = await probeAndMaybeResume(
      prisma,
      sourceAt(BACKOFF_TICKER, HIT_CLOSE),
      'CRYPTO',
      sourceAt(BACKOFF_TICKER, MISS_CLOSE, 'second'),
      BATCH_NOW,
      'enforce',
    );
    expect(first.disagreed).toBeGreaterThan(0);
    expect(first.failures).toBe(1);

    // 1분 뒤 — 아직 때가 아니다. **실패로 세지 않는다**(그러면 6분 만에 포기한다)
    const tooSoon = await probeAndMaybeResume(
      prisma,
      sourceAt(BACKOFF_TICKER, HIT_CLOSE),
      'CRYPTO',
      sourceAt(BACKOFF_TICKER, MISS_CLOSE, 'second'),
      new Date(BATCH_NOW.getTime() + 60_000),
      'enforce',
    );
    expect(tooSoon.skipped).toBe(true);
    expect(tooSoon.checked).toBe(0);
    expect(tooSoon.failures).toBe(1); // 그대로

    // 3분 뒤 — 때가 됐고, 이번엔 소스가 돌아왔다
    const later = await probeAndMaybeResume(
      prisma,
      sourceAt(BACKOFF_TICKER, HIT_CLOSE),
      'CRYPTO',
      sourceAt(BACKOFF_TICKER, HIT_CLOSE, 'second'),
      new Date(BATCH_NOW.getTime() + 3 * 60_000),
      'enforce',
    );
    expect(later.skipped).toBe(false);
    expect(later.resumed).toBe(true);
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(false);
  });
});

// **자동 정지가 잦아지는 것 자체가 신호다** (2026-08-15, 외부 검토 E-2).
//
// 자동 해제가 잘 도는 동안에는 아무도 아프지 않아서 소스의 불안정이 감사 로그 안에만
// 남는다. 계약을 다시 볼 근거는 자동 해제가 실패하는 날이 아니라 그 전에 있어야 한다.
describe('소스 불안정 지표', () => {
  const ep = (minutes: number | null) => ({
    assetClass: 'CRYPTO',
    pausedAt: new Date('2026-08-01T00:00:00Z'),
    resumedAt: minutes === null ? null : new Date('2026-08-01T01:00:00Z'),
    minutes,
  });

  it('지터(5분 미만)는 빈도에서 빼되 누적 시간에는 넣는다', () => {
    // 짧아도 잦으면 총 정지 시간이 늘고, 그만큼 판정이 밀린 것은 사실이다
    const v = sourceInstabilityVerdict([ep(1), ep(2), ep(3), ep(4), ep(1)]);
    expect(v.counted).toBe(0);
    expect(v.totalMinutes).toBe(11);
    expect(v.overFrequency).toBe(false);
  });

  it('잦으면 빈도로 걸린다 — 짧아도 자주면 엔드포인트 문제다', () => {
    const v = sourceInstabilityVerdict(Array.from({ length: 5 }, () => ep(10)));
    expect(v.counted).toBe(5);
    expect(v.overFrequency).toBe(true);
    expect(v.overDuration).toBe(false); // 50분 — 누적 문턱(120분)에는 못 닿는다
  });

  it('드물어도 길면 누적 시간으로 걸린다 — 공급자 복구 능력 문제다', () => {
    const v = sourceInstabilityVerdict([ep(70), ep(60)]);
    expect(v.counted).toBe(2);
    expect(v.overFrequency).toBe(false);
    expect(v.overDuration).toBe(true);
  });

  it('아직 안 풀린 정지도 지금까지의 시간으로 센다', () => {
    const v = sourceInstabilityVerdict([ep(null)]);
    expect(v.totalMinutes).toBe(0); // minutes가 null이면 0으로 — 지어내지 않는다
  });
});

// **복합 경로 — 방어층끼리 어긋나던 세 자리** (2026-08-15, 외부 검토 F-4).
//
// 32회차 동안 방어를 하나씩 쌓았는데, 각각은 시험이 있어도 **둘이 동시에 걸리는 순간**은
// 아무도 안 봤다. 검토가 그 조합 셋을 짚었고 전부 진짜였다.
describe('복합 경로 ① 정지 직후의 상한 경합', () => {
  it('막 걸린 시스템 정지는 상한을 유예한다 — 순간 장애로 헛발동하지 않게', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });
    const RACE_TICKER = 'KRW-RC1';
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker: RACE_TICKER, name: RACE_TICKER, shortable: true },
    ]);
    const reportId = await publishCard(RACE_TICKER);

    // 시스템이 방금 정지를 걸었다
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: '시험: 정지 직후',
    });
    // 정지가 시작된 시각을 배치가 쓰는 시계에 맞춘다 (배치는 now를 넘긴다)
    await beginRecovery(prisma, 'CRYPTO', [], PAST_CAP);

    // 상한이 지난 시각에 배치가 돈다 — 예전에는 여기서 전액 환불로 닫혔다
    const during = await judgeAndSettleDueCards(
      prisma,
      sourceAt(RACE_TICKER, HIT_CLOSE),
      PAST_CAP,
      'CRYPTO',
    );
    expect(during.hardCapped).toHaveLength(0);
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    expect(await prisma.judgment.findUnique({ where: { predictionCardId: card.id } })).toBeNull();

    // 유예가 끝나면(자동 회복이 끝까지 갈 수 있는 시간) 상한이 그대로 집행된다 —
    // **무기한 유예가 아니다.** 구매자 약속은 14일 + 1시간이지 사람이 풀 때까지가 아니다
    const after = await judgeAndSettleDueCards(
      prisma,
      sourceAt(RACE_TICKER, HIT_CLOSE),
      new Date(PAST_CAP.getTime() + PAUSE_GRACE_MS + 60_000),
      'CRYPTO',
    );
    expect(after.hardCapped.length).toBeGreaterThan(0);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });

  it('사람이 건 정지에는 유예가 없다 — 끝이 정해져 있지 않으므로', async () => {
    const HUMAN_TICKER = 'KRW-RC2';
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker: HUMAN_TICKER, name: HUMAN_TICKER, shortable: true },
    ]);
    await publishCard(HUMAN_TICKER);
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: operatorId,
      reason: '시험: 사람 정지',
    });

    const during = await judgeAndSettleDueCards(
      prisma,
      sourceAt(HUMAN_TICKER, HIT_CLOSE),
      PAST_CAP,
      'CRYPTO',
    );
    expect(during.hardCapped.length).toBeGreaterThan(0);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });
});

describe('복합 경로 ② 자동 해제와 사람의 정지가 겹칠 때', () => {
  it('탐침이 재는 동안 사람이 정지를 걸면 자동 해제를 버린다', async () => {
    // 사람이 건 정지 상태에서 조건부 갱신을 시도한다 — 0행이어야 한다
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: operatorId,
      reason: '시험: 사람이 먼저 걸었다',
    });
    const ok = await resumeIfSystemPaused(prisma, 'CRYPTO', '탐침 합의');
    expect(ok).toBe(false);
    // **사람의 정지가 그대로 남아 있다** — 기계가 덮어쓰지 못했다
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(true);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });
});

describe('복합 경로 ③ 탐침이 깨진 카드를 본다', () => {
  it('불일치 카드는 manualJudgmentOnly인데도 탐침 표적이 된다', async () => {
    const T = 'KRW-TG1';
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker: T, name: T, shortable: true },
    ]);
    const reportId = await publishCard(T);

    // 불일치로 수동 큐에 올린다 (= manualJudgmentOnly)
    await judgeAndSettleDueCards(
      prisma,
      sourceAt(T, HIT_CLOSE),
      BATCH_NOW,
      'CRYPTO',
      undefined,
      undefined,
      sourceAt(T, MISS_CLOSE, 'second'),
      'enforce',
    );
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    expect(card.manualJudgmentOnly).toBe(true);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: '시험: 표적',
    });
    await beginRecovery(prisma, 'CRYPTO', [{ id: card.id, ticker: T }], BATCH_NOW);

    // 표적 카드가 여전히 갈리면 **정지가 안 풀려야 한다.**
    // 예전에는 manualJudgmentOnly 필터가 이 카드를 빼서, 멀쩡한 다른 카드만 보고 풀었다
    const stillBroken = await probeAndMaybeResume(
      prisma,
      sourceAt(T, HIT_CLOSE),
      'CRYPTO',
      sourceAt(T, MISS_CLOSE, 'second'),
      BATCH_NOW,
      'enforce',
    );
    expect(stillBroken.disagreed).toBeGreaterThan(0);
    expect(stillBroken.resumed).toBe(false);
    expect(await isJudgmentPaused(prisma, 'CRYPTO')).toBe(true);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });
});

// **하드락 뒤에도 사람에게 하루를 준다** (2026-08-15, 외부 검토 E-1).
//
// 하드락은 자동 복구가 불가능한 실제 장애를 뜻하고, 그것은 밤에도 주말에도 난다.
// 62분 뒤 곧바로 상한을 집행하면 **금요일 밤에 피드가 끊긴 것 때문에 실제로 적중한
// 카드가 전액 환불로 끝난다** — 사람이 손쓸 시간이 0인 셈이다.
//
// 다만 **사람을 기다리지는 않는다.** 24시간이 지나면 아무도 안 왔어도 집행된다.
describe('하드락 유예 — 하루를 주되 무기한은 아니다', () => {
  const LOCK_TICKER = 'KRW-HD1';

  it('하드락 직후에는 상한을 미루고, 24시간이 지나면 집행한다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker: LOCK_TICKER, name: LOCK_TICKER, shortable: true },
    ]);
    const reportId = await publishCard(LOCK_TICKER);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: '시험: 하드락',
    });
    // 하드락 상태를 직접 만든다 (탐침 6회 실패의 결과와 같은 모양)
    await writeRecovery(prisma, 'CRYPTO', {
      status: 'HARD_LOCKED',
      pausedAt: PAST_CAP.getTime(),
      lockedAt: PAST_CAP.getTime(),
      failures: PROBE_MAX_FAILURES,
      cause: 'PROVIDER_DOWN',
    });

    // 하드락 직후 — 아직 하루가 안 지났으므로 미룬다
    const soon = await judgeAndSettleDueCards(
      prisma,
      sourceAt(LOCK_TICKER, HIT_CLOSE),
      new Date(PAST_CAP.getTime() + 3_600_000),
      'CRYPTO',
    );
    expect(soon.hardCapped).toHaveLength(0);

    // 하루가 지나면 아무도 안 왔어도 집행한다 — **사람을 기다리지 않는다**
    const late = await judgeAndSettleDueCards(
      prisma,
      sourceAt(LOCK_TICKER, HIT_CLOSE),
      new Date(PAST_CAP.getTime() + HARD_LOCK_GRACE_MS + 60_000),
      'CRYPTO',
    );
    expect(late.hardCapped.length).toBeGreaterThan(0);
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    const j = await prisma.judgment.findUniqueOrThrow({ where: { predictionCardId: card.id } });
    expect(j.undecidableReason).toBe('DATA_UNAVAILABLE');

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });

  it('하드락 상태에서는 탐침이 더 두드리지 않는다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: '시험: 하드락 유지',
    });
    await writeRecovery(prisma, 'CRYPTO', {
      status: 'HARD_LOCKED',
      pausedAt: BATCH_NOW.getTime(),
      lockedAt: BATCH_NOW.getTime(),
      failures: PROBE_MAX_FAILURES,
      cause: 'MISMATCH',
    });
    const r = await probeAndMaybeResume(
      prisma,
      sourceAt(LOCK_TICKER, HIT_CLOSE),
      'CRYPTO',
      sourceAt(LOCK_TICKER, HIT_CLOSE, 'second'),
      BATCH_NOW,
      'enforce',
    );
    expect(r.hardLocked).toBe(true);
    expect(r.checked).toBe(0); // 두 소스가 다시 일치해도 두드리지 않는다
    expect(r.resumed).toBe(false);

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });
});

// **유예의 합에도 끝이 있어야 한다** (2026-08-16, 외부 검토 E-2).
//
// 유예 하나하나에는 끝이 있었다(탐침 62분, 하드락 24시간). 그런데 정지가 풀렸다
// 다시 걸리면 유예도 새로 시작하므로, 공급자가 30분마다 흔들리면 **상한이 무한정
// 밀린다** — 구매자의 환불 시각에 사실상 상한이 없었다.
//
// 이제 유예는 상한을 건너뛰지 않고 **문턱을 14일에서 16일로 올릴 뿐**이다.
describe('절대 시한 — 흔들리는 소스가 상한을 무한정 밀지 못하게', () => {
  const FLAP_TICKER = 'KRW-FL1';

  it('유예 중이어도 절대 시한을 넘긴 카드는 닫힌다', async () => {
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 준비',
    });
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker: FLAP_TICKER, name: FLAP_TICKER, shortable: true },
    ]);
    const reportId = await publishCard(FLAP_TICKER);

    // 시한 후 17일 — 절대 시한(16일)을 넘겼다
    const wayLate = new Date(DEADLINE.getTime() + (JUDGMENT_ABSOLUTE_CAP_DAYS + 1) * 86_400_000);
    // 그런데 **방금** 사고가 나서 유예가 살아 있다 (소스가 계속 흔들린 결과)
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: '시험: 방금 또 흔들림',
    });
    await beginRecovery(prisma, 'CRYPTO', [], wayLate);

    const summary = await judgeAndSettleDueCards(
      prisma,
      sourceAt(FLAP_TICKER, HIT_CLOSE),
      wayLate,
      'CRYPTO',
    );
    // 유예가 살아 있어도 절대 시한을 넘겼으므로 닫는다
    expect(summary.hardCapped.length).toBeGreaterThan(0);
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    const j = await prisma.judgment.findUniqueOrThrow({ where: { predictionCardId: card.id } });
    expect(j.undecidableReason).toBe('DATA_UNAVAILABLE');

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });

  it('절대 시한 전이면 유예가 그대로 듣는다 (정상적인 사고 한 번은 여기서 풀린다)', async () => {
    const OK_TICKER = 'KRW-FL2';
    await seedTestInstruments(prisma, [
      { assetClass: 'CRYPTO', ticker: OK_TICKER, name: OK_TICKER, shortable: true },
    ]);
    const reportId = await publishCard(OK_TICKER);

    // 시한 후 15일 — 14일 상한은 넘었지만 절대 시한(16일) 전이다
    const between = new Date(DEADLINE.getTime() + 15 * 86_400_000);
    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: true,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: '시험: 유예 중',
    });
    await beginRecovery(prisma, 'CRYPTO', [], between);

    const summary = await judgeAndSettleDueCards(
      prisma,
      sourceAt(OK_TICKER, HIT_CLOSE),
      between,
      'CRYPTO',
    );
    expect(summary.hardCapped).toHaveLength(0);
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
    expect(await prisma.judgment.findUnique({ where: { predictionCardId: card.id } })).toBeNull();

    await setJudgmentPause(prisma, {
      scope: 'CRYPTO',
      paused: false,
      operatorUserId: operatorId,
      reason: '시험 정리',
    });
  });
});
