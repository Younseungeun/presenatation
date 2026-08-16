import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import type { DailyQuote, ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { applyInstrumentListings } from '../instrumentService';
import { createDraftReport, publishReport, INSUFFICIENT_MARKET_DATA } from '../reportService';
import { PublishValidationError } from '@/domain/publishReport';

// **σ를 못 잰 종목은 게시할 수 없다** (42차 확정) — 그리고 그 차단이 장애로 번지지 않는다.
//
// 우리가 파는 것은 리포트가 아니라 "이 예측이 무정보 대비 얼마나 위인가"다. p₀를
// 짐작으로 계산한 카드는 **뒷받침할 수 없는 점수를 파는 것**이라 상품이 성립하지 않는다.
// 실측하면 실력 0인 사람이 그런 종목만 골라 카드당 +11 ~ +67을 벌 수 있었다
// (scripts/probeNewListingSigma.ts).
//
// 이 파일이 지키는 두 성질이 서로를 견제한다:
//   ① 표본이 모자란 종목은 **막힌다** — 안 막으면 파밍이 열린다
//   ② 시세를 못 받은 종목은 **안 막힌다** — 막으면 소스 장애 한 번이 전체 게시를 세운다
// 하나만 시험하면 반대쪽으로 고치는 것을 아무도 못 잡는다.

let prisma: PrismaClient;
let researcherId: string;

const DRAFT_NOW = new Date('2026-03-01T00:00:00Z');
const PUBLISH_NOW = new Date('2026-03-02T00:00:00Z');
const DEADLINE = new Date('2026-04-15T00:00:00Z');

function bars(n: number): DailyQuote[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + (i % 7) - 3;
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    return { date, open: close, high: close + 1, low: close - 1, close, volume: 1_000 + i };
  });
}

const registry = (ticker: string, quotes: DailyQuote[]): ProviderRegistry => ({
  CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, quotes),
});

const draftFor = (ticker: string) => ({
  researcherId,
  title: '제목입니다 충분히 길게',
  summary: '요약입니다. 충분히 긴 요약 문장을 적어 둡니다.',
  content: '본문입니다. '.repeat(40),
  priceKrw: 10_000,
  prepaymentRatio: 0 as const,
  card: {
    assetClass: 'CRYPTO' as const,
    ticker,
    assetName: ticker.slice(4),
    direction: 'UP' as const,
    targetType: 'RETURN_PCT' as const,
    targetValue: 80,
    confidence: 5,
    selfStability: 5,
    deadline: DEADLINE,
  },
});

beforeAll(async () => {
  prisma = createTestDb('sigma-gate-');
  // **σ를 심지 않는다** — seedTestInstruments는 픽스처 σ를 넣어 주는데, 이 시험은
  // 정확히 "σ가 없는 종목"을 다루므로 그 헬퍼를 쓰면 시험할 것이 사라진다
  await applyInstrumentListings(prisma, 'CRYPTO', 'seed', [
    { ticker: 'KRW-NEW', name: '신규상장', currency: 'KRW' },
    { ticker: 'KRW-OUT', name: '장애종목', currency: 'KRW' },
    { ticker: 'KRW-OLD', name: '오래된종목', currency: 'KRW' },
  ]);
  const r = await prisma.user.create({
    data: { email: 'r@sigma.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
});

/** 게시된 리포트의 카드를 다시 읽는다 — publishReport는 카드를 돌려주지 않는다 */
async function cardOf(reportId: string) {
  return prisma.predictionCard.findFirstOrThrow({
    where: { reportId },
    include: { report: { select: { status: true } } },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('σ 미측정 종목의 게시 관문', () => {
  it('표본이 모자란 종목은 게시가 막힌다 — 사유와 언제 풀리는지를 함께 말한다', async () => {
    const reg = registry('KRW-NEW', bars(10));
    const draft = await createDraftReport(prisma, draftFor('KRW-NEW'), DRAFT_NOW);

    await expect(publishReport(prisma, reg, draft.id, researcherId, PUBLISH_NOW)).rejects.toThrow(
      PublishValidationError,
    );
    // 문구가 "왜 막혔고 언제 풀리는가"를 담고 있어야 한다 — "안 됩니다"만으로는 규칙이 임의로 보인다
    expect(INSUFFICIENT_MARKET_DATA).toContain('20거래일');
    expect(INSUFFICIENT_MARKET_DATA).toContain('자동으로 열립니다');

    const after = await prisma.report.findUnique({ where: { id: draft.id } });
    expect(after!.status).toBe('DRAFT'); // 막혔으면 초안 그대로 남는다
  });

  it('**시세를 못 받은 것만으로는 막지 않는다** — 소스 장애가 전체 게시를 세우면 안 된다', async () => {
    const reg = registry('KRW-OUT', []); // 일봉이 아예 안 온다
    const draft = await createDraftReport(prisma, draftFor('KRW-OUT'), DRAFT_NOW);

    await publishReport(prisma, reg, draft.id, researcherId, PUBLISH_NOW);
    const card = await cardOf(draft.id);
    expect(card.report.status).toBe('PUBLISHED');
    // σ는 비어 있고, 채점은 거친 쪽 폴백으로 간다 (domain/scoring.UNMEASURED_SIGMA)
    expect(card.sigmaDaily).toBeNull();
  });

  it('한 번이라도 잰 적이 있으면 지금 못 재도 막지 않는다 — 표본 문제가 아니라 장애다', async () => {
    await prisma.instrument.update({
      where: { assetClass_ticker: { assetClass: 'CRYPTO', ticker: 'KRW-OLD' } },
      data: { sigmaDaily: 0.03, sigmaSyncedAt: new Date('2020-01-01T00:00:00Z') }, // 한참 낡은 캐시
    });
    const reg = registry('KRW-OLD', bars(5)); // 지금 재면 표본 부족으로 나오는 상황
    const draft = await createDraftReport(prisma, draftFor('KRW-OLD'), DRAFT_NOW);

    await publishReport(prisma, reg, draft.id, researcherId, PUBLISH_NOW);
    const card = await cardOf(draft.id);
    expect(card.report.status).toBe('PUBLISHED');
    expect(card.sigmaDaily).toBeCloseTo(0.03, 6);
  });

  it('표본이 충분하면 그대로 게시된다 — 관문이 통과 경로를 실제로 갖고 있다', async () => {
    await applyInstrumentListings(prisma, 'CRYPTO', 'seed2', [
      { ticker: 'KRW-NEW', name: '신규상장', currency: 'KRW' },
      { ticker: 'KRW-OUT', name: '장애종목', currency: 'KRW' },
      { ticker: 'KRW-OLD', name: '오래된종목', currency: 'KRW' },
      { ticker: 'KRW-FINE', name: '정상종목', currency: 'KRW' },
    ]);
    const reg = registry('KRW-FINE', bars(60));
    const draft = await createDraftReport(prisma, draftFor('KRW-FINE'), DRAFT_NOW);

    await publishReport(prisma, reg, draft.id, researcherId, PUBLISH_NOW);
    const card = await cardOf(draft.id);
    expect(card.report.status).toBe('PUBLISHED');
    expect(card.sigmaDaily).toBeGreaterThan(0);
  });
});


