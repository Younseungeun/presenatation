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
  judgeAndSettleDueCards,
  shouldHaltOnDisagreement,
  DISAGREEMENT_HALT_MIN,
} from '../judgmentBatch';
import { createDraftReport, publishReport } from '../reportService';
import { manualJudgeCard } from '../manualJudgmentService';
import { isJudgmentPaused, setJudgmentPause } from '../judgmentPause';

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
    expect(summary.haltedAssetClass).toBe('CRYPTO');
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
