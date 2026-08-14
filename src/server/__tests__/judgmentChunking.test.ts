import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  DEFER_BACKOFF_MS,
  HARD_CAP_BLOCK_THRESHOLD,
  JUDGE_BATCH_SIZE,
  JUDGMENT_HARD_CAP_DAYS,
  MAX_DEFER_ATTEMPTS,
  judgeAndSettleDueCards,
  nextAttemptAfterDefer,
} from '../judgmentBatch';
import { createDraftReport, publishReport } from '../reportService';
import { searchInstruments, validateListedInstrument } from '../instrumentService';

// **판정 배치는 한 회차 JUDGE_BATCH_SIZE장으로 끊는다.**
//
// KIS 호출 간격이 1.1초라 분기말처럼 시한이 몰린 날 수백 장을 한 회차에 처리하면
// 큐 뒤의 다른 배치가 통째로 밀리고, 토큰 만료·재시작이 끼면 그 회차가 날아간다.
//
// 끊는 순간 **이월 카드가 앞자리를 영구히 막는 함정**이 생긴다: 이월은 Judgment 행을
// 만들지 않아 다음 조회에도 그대로 잡히므로, 커서 없이 take만 쓰면 매 회차 같은 20장을
// 다시 가져오고 그 뒤 카드는 영원히 판정되지 않는다. 그래서 커서로 앞으로 나아간다.

let prisma: PrismaClient;
/** 자산군별 동시 활성 카드 상한(최상위 등급 15장)에 걸리지 않게 여럿에 나눠 찍는다 */
const researcherIds: string[] = [];

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');

/** 시세가 아예 없는 공급자 — 모든 카드가 **이월**된다 (판정도 실패도 아님) */
const noQuotes: ProviderRegistry = { CRYPTO: new FixtureMarketDataProvider() };

/**
 * 예상 밖으로 터지는 공급자 — 이월(JudgmentDeferredError)이 아니라 **우리 버그**의 대역.
 * 공급자가 JSON이 아닌 HTML 오류 페이지를 주거나, 응답 규격이 바뀌었을 때 실제로 이렇게 된다
 */
const boom: ProviderRegistry = {
  CRYPTO: {
    sourceId: 'boom',
    getDailyQuotes: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    getSecurityStatus: () => Promise.resolve({ halted: false, delisted: false }),
  },
};

/** 목표 미달 종가를 주는 공급자 — 실제로 판정(MISS)된다 */
function withQuotes(tickers: string[]): ProviderRegistry {
  const p = new FixtureMarketDataProvider();
  for (const t of tickers) {
    p.setCurrentPrice(t, 100).setQuotes(t, [
      { date: '2026-07-20', open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { date: '2026-08-01', open: 95, high: 95, low: 95, close: 95, volume: 1 },
    ]);
  }
  return { CRYPTO: p };
}

async function publishCard(ticker: string, researcherId: string) {
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

const TOTAL = JUDGE_BATCH_SIZE + 5; // 한 회차로는 안 끝나는 양
const TICKERS = Array.from({ length: TOTAL }, (_, i) => `KRW-CH${i}`);
/** 같은 종목에서 판정 불가가 반복되는 것을 시험할 티커 (카드 2장을 여기에 건다) */
const REPEAT_TICKER = 'KRW-DEAD';
/** 예상 밖 오류 경로 전용 — 앞선 시험들이 카드를 다 소진하므로 여기서 새로 찍는다 */
const ERROR_TICKERS = ['KRW-ERR1', 'KRW-ERR2'];

beforeAll(async () => {
  prisma = createTestDb('judge-chunk-');
  await seedTestInstruments(
    prisma,
    [...TICKERS, REPEAT_TICKER, ...ERROR_TICKERS].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker,
      shortable: true,
    })),
  );
  // 상한이 넉넉한 등급 + 여럿에 분산 — 이 시험의 대상은 게시 상한이 아니라 배치 청킹이다
  for (const n of [1, 2, 3]) {
    const u = await prisma.user.create({
      data: {
        email: `r${n}@chunk.io`,
        identityVerified: true,
        researcherProfile: { create: { tier: 'CHALLENGER' } },
      },
      include: { researcherProfile: true },
    });
    researcherIds.push(u.researcherProfile!.id);
  }
  for (const [i, t] of TICKERS.entries()) {
    await publishCard(t, researcherIds[i % researcherIds.length]);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('판정 배치 청킹', () => {
  it(`한 회차는 ${JUDGE_BATCH_SIZE}장까지만 손대고 더 있다고 알린다`, async () => {
    const first = await judgeAndSettleDueCards(prisma, noQuotes, BATCH_NOW);
    expect(first.deferred).toBe(JUDGE_BATCH_SIZE);
    expect(first.judged).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).not.toBeNull();
  });

  it('**커서가 이월 카드를 넘어간다** — 없으면 뒤의 카드가 영원히 판정되지 않는다', async () => {
    // 앞의 20장은 시세가 없어 계속 이월된다(Judgment가 안 생겨 매번 다시 잡힌다).
    // 커서 없이 돌면 두 번째 회차도 같은 20장을 가져와 뒤의 5장에 절대 닿지 못한다
    const first = await judgeAndSettleDueCards(prisma, noQuotes, BATCH_NOW);
    expect(first.judged).toBe(0);

    // 뒤에 남은 카드에는 시세가 있다 → 커서가 제대로 넘어갔다면 판정된다
    const rest = TICKERS.slice(JUDGE_BATCH_SIZE);
    const second = await judgeAndSettleDueCards(
      prisma,
      withQuotes(rest),
      BATCH_NOW,
      undefined,
      first.cursor!,
    );
    expect(second.judged).toBe(rest.length);
    expect(second.hasMore).toBe(false);

    // 실제로 정산까지 끝났는지 — 개수만 세면 "돌긴 돌았다"에 속을 수 있다
    const judged = await prisma.judgment.count();
    expect(judged).toBe(rest.length);
  });

  // **반복해서 실패하는 카드는 뒤로 미룬다.** 이월은 Judgment를 안 만들어 다음 조회에도
  // 그대로 잡히므로, 미루지 않으면 매 회차 KIS 호출을 갉아먹는다(100건이면 110초를
  // 아무 성과 없이 쓴다). 첫 실패는 미루지 않는다 — 벌해야 하는 것은 반복이다
  it('반복 이월은 다음 시도를 뒤로 밀어 뜨거운 큐에서 뺀다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { judgment: null },
      orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    });
    expect(card.deferCount).toBeGreaterThan(1); // 앞선 시험들이 여러 번 이월시켰다
    expect(card.nextAttemptAt).not.toBeNull();
    // 2회차부터는 실제로 미래로 밀린다 (1회차는 0이라 즉시 재시도)
    expect(card.nextAttemptAt!.getTime()).toBeGreaterThan(BATCH_NOW.getTime());

    // 그래서 같은 시각에 다시 돌려도 이 카드는 조회에 안 잡힌다
    const again = await judgeAndSettleDueCards(prisma, noQuotes, BATCH_NOW);
    expect(again.cursor?.id).not.toBe(card.id);
  });

  // **횟수로 자동 재시도를 끊지 않는다.** deferCount는 시도 횟수지 시간이 아니라서,
  // 기동 따라잡기가 잦으면(배포·재시작) 시간이 안 흘렀는데 예산만 소진된다 —
  // 멀쩡한 카드가 그렇게 사람 손으로 밀려나면 안 된다
  it('재시도 횟수를 다 써도 배치가 손을 떼지 않는다 — 데이터가 돌아오면 스스로 낫는다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { judgment: null },
      orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    });
    await prisma.predictionCard.update({
      where: { id: card.id },
      data: { deferCount: MAX_DEFER_ATTEMPTS + 3, nextAttemptAt: null },
    });

    // 시세가 돌아온 상황 — 횟수와 무관하게 판정된다
    const s = await judgeAndSettleDueCards(prisma, withQuotes([card.ticker]), BATCH_NOW);
    expect(s.judged).toBeGreaterThan(0);
    const judged = await prisma.judgment.findFirst({ where: { predictionCardId: card.id } });
    expect(judged).not.toBeNull();
  });

  // **무기한 기다리게 두지 않는다.** 구매자는 "이 시점까지 이 가격"을 샀는데 시세 소스
  // 장애로 판정이 미뤄지는 것은 전적으로 플랫폼 사정이다 — 그 대가를 에스크로에 묶인
  // 돈으로 치를 이유가 없다
  it(`시한 후 ${JUDGMENT_HARD_CAP_DAYS}일이 지나면 판정 불가로 닫고 전액 환불한다`, async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { judgment: null },
      orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    });
    const wayLate = new Date(card.deadline.getTime() + (JUDGMENT_HARD_CAP_DAYS + 1) * 86_400_000);

    const s = await judgeAndSettleDueCards(prisma, noQuotes, wayLate);
    expect(s.hardCapped.length).toBeGreaterThan(0);

    const judgment = await prisma.judgment.findFirstOrThrow({
      where: { predictionCardId: card.id },
    });
    expect(judgment.outcome).toBe('UNDECIDABLE');
    expect(judgment.undecidableReason).toBe('DATA_UNAVAILABLE');
    // 소스 장애의 대가를 리서처가 지면 안 된다 — 점수도 증거도 0
    expect(judgment.score).toBe(0);
    expect(judgment.info).toBe(0);
  });

  // **상한이 생긴 뒤로는 간격이 곧 놓칠 확률이다.** 예전 마지막 눈금(사흘)이면 5일째
  // 되살아난 시세를 8일째에야 본다 — 그 사흘은 에스크로에 묶인 채 헛산 시간이고,
  // 최악의 경우 상한 직전에 돌아온 데이터를 못 보고 판정 불가로 닫는다
  it('마지막 재시도 간격은 하루를 넘지 않는다 — 상한 안에서 시세 복귀를 놓치지 않게', () => {
    const last = DEFER_BACKOFF_MS[DEFER_BACKOFF_MS.length - 1];
    expect(last).toBe(24 * 3_600_000);

    // 눈금을 다 써도 하루 간격이 유지된다 (클램프) — 뒤로 갈수록 뜸해지지 않는다
    const t0 = new Date('2026-08-02T00:00:00Z');
    expect(nextAttemptAfterDefer(DEFER_BACKOFF_MS.length + 5, t0).getTime() - t0.getTime()).toBe(
      last,
    );

    // 상한에 닿기 전에 충분히 여러 번 두드린다
    expect((JUDGMENT_HARD_CAP_DAYS * 86_400_000) / last).toBeGreaterThanOrEqual(10);
  });

  // **상한은 구매자를 구하지만 원인을 고치지 않는다.** 시세를 못 구하는 종목은 다음
  // 카드도 똑같이 끝나므로, 반복되면 그 종목의 신규 게시를 막는다.
  // (리서처가 시세를 직접 제출해 구제받는 창구는 열지 않는다 — 판정의 값어치가
  //  "플랫폼이 중립적인 원천으로 잰다"에서 오는데, 당사자 숫자를 받으면 그게 사라진다)
  it(`같은 종목이 ${HARD_CAP_BLOCK_THRESHOLD}번 판정 불가면 그 종목의 신규 게시를 막는다`, async () => {
    await publishCard(REPEAT_TICKER, researcherIds[0]);
    await publishCard(REPEAT_TICKER, researcherIds[1]);

    const wayLate = new Date(DEADLINE.getTime() + (JUDGMENT_HARD_CAP_DAYS + 1) * 86_400_000);
    const s = await judgeAndSettleDueCards(prisma, noQuotes, wayLate);
    expect(s.hardCapped.length).toBe(2);

    // 두 번째에서 막힌다 — 한 번은 사건이고 두 번은 종목의 성질이다
    expect(s.blockedInstruments).toHaveLength(1);
    expect(s.blockedInstruments[0]).toContain(REPEAT_TICKER);

    const inst = await prisma.instrument.findUniqueOrThrow({
      where: { assetClass_ticker: { assetClass: 'CRYPTO', ticker: REPEAT_TICKER } },
    });
    expect(inst.unjudgeableAt).not.toBeNull();
    // **거래소 위험 등급과 섞지 않는다.** 처분(신규 게시 차단)은 같아도 riskLevel은
    // 거래소가 지정한 사실이고 이쪽은 우리 시세 소스의 한계다 — 한 칸에 담으면
    // 공급자를 갈아 끼울 때 "진짜 상폐"와 "우리가 못 구한 것"을 구분할 수 없다
    expect(inst.riskLevel).toBe('NONE');
    // 진행 중인 카드와 돈은 건드리지 않는다 — 유니버스만 줄인다
    expect(inst.active).toBe(true);

    // 알림을 밀지 않고 당긴다 — 검색에서 빠지고, 티커를 직접 아는 사람에게는
    // 게시 검증이 사유를 말한다 (그것도 "종목이 나쁘다"가 아니라 "우리가 못 잰다"로)
    expect(await searchInstruments(prisma, 'CRYPTO', REPEAT_TICKER)).toHaveLength(0);
    const check = await validateListedInstrument(prisma, 'CRYPTO', REPEAT_TICKER, 'UP');
    expect(check.issues[0]).toContain('시세 검증을 지원하지 못하는');
  });

  // **가장 조용한 구멍이었다.** 예상 밖 오류는 로그만 찍고 끝났다:
  //  · 백오프가 안 걸려 매 회차 같은 카드를 다시 부른다 (KIS 호출을 영원히 갉아먹는다)
  //  · 상한이 이월 경로에만 있어 **에스크로가 영원히 안 풀린다**
  //  · 이월은 정차 큐, 상한은 전용 알림이 있는데 **버그로 죽는 카드만 아무도 몰랐다**
  it('예상 밖 오류도 이월과 같은 절차를 밟는다 — 백오프·알림·상한', async () => {
    await publishCard(ERROR_TICKERS[0], researcherIds[0]);
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { ticker: ERROR_TICKERS[0] },
    });

    const s = await judgeAndSettleDueCards(prisma, boom, BATCH_NOW);
    expect(s.failed).toBeGreaterThan(0);

    // ① 이월과 **다른 목록**으로 올라온다 — 처방이 다르기 때문이다.
    //    이월은 기다리면 낫지만 이건 코드를 고치기 전에는 몇 번을 돌려도 같다
    expect(s.failures.length).toBeGreaterThan(0);
    expect(s.failures[0]).toContain('JSON');
    expect(s.deferred).toBe(0);

    // ② 백오프가 걸려 매 회차 같은 카드를 다시 부르지 않는다
    const after = await prisma.predictionCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.deferCount).toBeGreaterThan(0);
    expect(after.nextAttemptAt).not.toBeNull();
  });

  // 원인이 무엇이든 구매자가 무기한 기다릴 이유는 없다 — 상한은 이월 경로 전용이 아니다
  it('예상 밖 오류로도 상한에 닿으면 닫고 환불한다 — 원인은 감사 기록에 남긴다', async () => {
    await publishCard(ERROR_TICKERS[1], researcherIds[1]);
    const card = await prisma.predictionCard.findFirstOrThrow({
      where: { ticker: ERROR_TICKERS[1] },
    });
    const wayLate = new Date(card.deadline.getTime() + (JUDGMENT_HARD_CAP_DAYS + 1) * 86_400_000);

    const s = await judgeAndSettleDueCards(prisma, boom, wayLate);
    expect(s.hardCapped.length).toBeGreaterThan(0);

    const judgment = await prisma.judgment.findFirstOrThrow({
      where: { predictionCardId: card.id },
    });
    expect(judgment.outcome).toBe('UNDECIDABLE');
    // 구매자에게는 똑같이 "판정 불가·전액 환불"이지만, 나중에 "왜 못 쟀나"를 물으면
    // 답이 달라야 한다 — 시세를 못 구한 것과 우리 코드가 죽은 것은 다른 이야기다
    expect(judgment.dataSource).toBe('hard-cap:error');
    expect(JSON.parse(judgment.marketSnapshotJson!).cause).toBe('ERROR');
  });

  // 소스 전체가 하루 죽으면 수십 종목이 **한 번씩** 걸린다. 그때 종목을 무더기로
  // 내리면 장애 하나가 유니버스를 통째로 지운다 — 문턱이 1이 아닌 이유가 이것이다
  it('한 번씩 걸린 종목들은 막지 않는다 — 소스 장애가 유니버스를 지우면 안 된다', async () => {
    const blockedOnce = await prisma.instrument.count({
      where: { assetClass: 'CRYPTO', ticker: { in: TICKERS }, unjudgeableAt: { not: null } },
    });
    expect(blockedOnce).toBe(0);
  });
});
