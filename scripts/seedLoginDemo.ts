// 로그인 가능한 데모 계정 시드.
// 로그인 화면(본인 인증 스텁)은 전화번호로 결정적 CI를 만들므로, 같은 번호로 인증하면
// 항상 이 계정에 연결된다. 구매자·리서처 양쪽 화면을 모두 볼 수 있도록 데이터를 채운다.
// 실행: npm run seed:login   (이미 있으면 다시 만들지 않는다)
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ProviderRegistry } from '../src/domain/marketData';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import { hashCi } from '../src/server/authService';
import { judgeAndSettleDueCards } from '../src/server/judgmentBatch';
import { purchaseReport } from '../src/server/purchaseService';
import { createDraftReport, publishReport } from '../src/server/reportService';

const prisma = new PrismaClient();

// 로그인에 쓸 번호 — 로그인 화면에서 이 번호로 인증하면 이 계정으로 들어온다
const DEMO_PHONE = '01012345678';
const DEMO_PEN_NAME = '데모유저';

const PUBLISH_AT = new Date('2026-07-10T00:00:00Z');
const PAST_DEADLINE = new Date('2026-07-20T00:00:00Z');
const BATCH_NOW = new Date('2026-07-21T00:00:00Z');
const LIVE_DEADLINE = new Date('2026-12-01T00:00:00Z');

const PRICES = {
  'KRW-BTC': { base: 100_000_000, settled: 115_000_000 }, // +15%
  'KRW-ETH': { base: 5_000_000, settled: 4_600_000 }, // -8%
  'KRW-SOL': { base: 250_000, settled: 250_000 },
} as const;

type Ticker = keyof typeof PRICES;

function reg(ticker: Ticker): ProviderRegistry {
  const { base, settled } = PRICES[ticker];
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, base).setQuotes(ticker, [
      { date: '2026-07-10', open: base, high: base, low: base, close: base, volume: 1 },
      {
        date: '2026-07-20',
        open: settled,
        high: Math.max(base, settled),
        low: Math.min(base, settled),
        close: settled,
        volume: 1,
      },
    ]),
  };
}

function batchRegistry(): ProviderRegistry {
  const provider = new FixtureMarketDataProvider();
  for (const [ticker, { base, settled }] of Object.entries(PRICES)) {
    provider.setCurrentPrice(ticker, base).setQuotes(ticker, [
      { date: '2026-07-10', open: base, high: base, low: base, close: base, volume: 1 },
      {
        date: '2026-07-20',
        open: settled,
        high: Math.max(base, settled),
        low: Math.min(base, settled),
        close: settled,
        volume: 1,
      },
    ]);
  }
  return { CRYPTO: provider };
}

interface ReportSpec {
  researcherId: string;
  title: string;
  summary: string;
  ticker: Ticker;
  assetName: string;
  targetValue: number; // 코인 크기 하한 10%
  priceKrw: number;
  deadline: Date;
  publishAt: Date;
}

async function publish(spec: ReportSpec): Promise<string> {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId: spec.researcherId,
      title: spec.title,
      summary: spec.summary,
      content: `${spec.assetName} 분석 본문입니다. 온체인 지표와 수급을 근거로 목표 구간을 제시합니다.`,
      priceKrw: spec.priceKrw,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker: spec.ticker,
        assetName: spec.assetName,
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: spec.targetValue,
        deadline: spec.deadline,
        confidence: 4,
        selfStability: 6,
      },
    },
    spec.publishAt,
  );
  await publishReport(prisma, reg(spec.ticker), draft.id, spec.researcherId, spec.publishAt);
  return draft.id;
}

async function main() {
  const ci = createHash('sha256').update(`stub-ci:${DEMO_PHONE}`).digest('base64');
  const identityHash = hashCi(ci);

  const existing = await prisma.user.findUnique({
    where: { identityHash },
    include: { researcherProfile: true },
  });
  if (existing) {
    console.log(`이미 존재하는 데모 계정입니다 (필명 ${existing.penName ?? '-'}). 데이터는 그대로 둡니다.`);
    console.log(`로그인: 이름 아무거나 / 휴대폰 ${DEMO_PHONE}`);
    return;
  }

  // 판매자(데모유저가 구매할 리포트를 쓴 사람) — 기존 데모 리서처 재사용
  const seller = await prisma.researcherProfile.findFirst({
    where: { user: { email: 'demo-researcher@test.io' } },
  });
  if (!seller) throw new Error('demo-researcher가 없습니다. 먼저 npm run seed:demo 를 실행하세요.');
  const otherBuyer = await prisma.user.findUnique({ where: { email: 'demo-buyer@test.io' } });
  if (!otherBuyer) throw new Error('demo-buyer가 없습니다. 먼저 npm run seed:demo 를 실행하세요.');

  const user = await prisma.user.create({
    data: {
      email: `${identityHash.slice(0, 24)}@identity.local`,
      penName: DEMO_PEN_NAME,
      identityVerified: true,
      identityHash,
      researcherProfile: { create: {} },
    },
    include: { researcherProfile: true },
  });
  const myResearcherId = user.researcherProfile!.id;

  // ── 구매자 화면용: 판정 완료 2건(적중·실패) + 검증 중 1건 ─────────────────
  const hitReport = await publish({
    researcherId: seller.id,
    title: '비트코인 7월 반등 구간',
    summary: '수급 개선 — 10% 상승 예측',
    ticker: 'KRW-BTC',
    assetName: '비트코인',
    targetValue: 10,
    priceKrw: 15_000,
    deadline: PAST_DEADLINE,
    publishAt: PUBLISH_AT,
  });
  const missReport = await publish({
    researcherId: seller.id,
    title: '이더리움 상승 전환 시나리오',
    summary: '업그레이드 기대 — 12% 상승 예측',
    ticker: 'KRW-ETH',
    assetName: '이더리움',
    targetValue: 12,
    priceKrw: 18_000,
    deadline: PAST_DEADLINE,
    publishAt: PUBLISH_AT,
  });
  await purchaseReport(prisma, hitReport, user.id, PUBLISH_AT);
  await purchaseReport(prisma, missReport, user.id, PUBLISH_AT);

  // 아직 판정 전인 카드(에스크로 보관 중) — 기존 솔라나 리포트를 구매
  const liveSol = await prisma.report.findFirst({
    where: { researcherId: seller.id, status: 'PUBLISHED', predictionCard: { ticker: 'KRW-SOL' } },
    orderBy: { publishedAt: 'desc' },
  });
  if (liveSol) await purchaseReport(prisma, liveSol.id, user.id, new Date());

  // ── 리서처 화면용: 내가 쓴 카드 2건(판정 완료 1 + 판매 중 1) ──────────────
  const myJudged = await publish({
    researcherId: myResearcherId,
    title: '비트코인 스윙 아이디어',
    summary: '변동성 확대 구간 — 15% 상승 예측',
    ticker: 'KRW-BTC',
    assetName: '비트코인',
    targetValue: 15,
    priceKrw: 12_000,
    deadline: PAST_DEADLINE,
    publishAt: PUBLISH_AT,
  });
  await purchaseReport(prisma, myJudged, otherBuyer.id, PUBLISH_AT);

  await publish({
    researcherId: myResearcherId,
    title: '솔라나 연말 목표가',
    summary: '생태계 확장 — 20% 상승 예측',
    ticker: 'KRW-SOL',
    assetName: '솔라나',
    targetValue: 20,
    priceKrw: 25_000,
    deadline: LIVE_DEADLINE,
    publishAt: new Date(),
  });

  // 시한 지난 카드 판정 → 점수·정산(환불) 확정
  const summary = await judgeAndSettleDueCards(prisma, batchRegistry(), BATCH_NOW);

  console.log('데모 계정 생성 완료');
  console.log(`  로그인: 이름 아무거나 / 휴대폰 ${DEMO_PHONE} (필명 ${DEMO_PEN_NAME})`);
  console.log(`  판정 ${summary.judged}건 · 이월 ${summary.deferred}건 · 실패 ${summary.failed}건`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
