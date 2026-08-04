// 히트맵 데모 시드: 국내주식 활성(검증 중) 예측 카드를 여러 리서처로 나눠 게시해
// 홈 예측 히트맵에 코인 옆 국내주식 구획이 나타나게 한다.
// - 브론즈 동시 활성 카드 상한(자산군당 5장) 때문에 리서처 3명에 분산한다
// - 하락(sell) 카드는 개별주식선물 상장(shortable) 종목만 게시 가능 — 전부 그 안에서 고른다
// - 방향 분포를 섞어 초록(상승 우세)·빨강(하락 우세)·회색(팽팽) 타일이 모두 나오게 한다
// 실행: npm run seed:heatmap   (이미 있으면 다시 만들지 않는다)
import { PrismaClient } from '@prisma/client';
import type { ProviderRegistry } from '../src/domain/marketData';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import { applyInstrumentListings } from '../src/server/instrumentService';
import { createDraftReport, publishReport } from '../src/server/reportService';

const prisma = new PrismaClient();

const EXTRA_RESEARCHERS = [
  { email: 'heatmap-r1@test.io', penName: '마켓워처' },
  { email: 'heatmap-r2@test.io', penName: '밸류헌터' },
] as const;

// 데모 종목 — 전부 KR 개별주식선물 유니버스(shortable) 안이라 하락 카드도 게시된다.
// price는 기준가 픽스처(실제 시세 아님).
const KR_STOCKS: Record<string, { name: string; price: number }> = {
  '005930': { name: '삼성전자', price: 71_000 },
  '000660': { name: 'SK하이닉스', price: 172_000 },
  '373220': { name: 'LG에너지솔루션', price: 345_000 },
  '005380': { name: '현대차', price: 245_000 },
  '035420': { name: 'NAVER', price: 187_000 },
  '035720': { name: '카카오', price: 41_000 },
  '068270': { name: '셀트리온', price: 178_000 },
  '012450': { name: '한화에어로스페이스', price: 290_000 },
};

// 종목별 방향 분포(컨센서스): 삼성전자 ▲3▼1(연한 초록), SK하이닉스 ▼2(빨강),
// LG엔솔 ▲2(초록), 카카오 ▲1▼1(팽팽 회색), 나머지 1건씩
interface CardSpec {
  researcher: 'seller' | 'r1' | 'r2';
  ticker: string;
  direction: 'UP' | 'DOWN';
  targetValue: number; // 국내주식 크기 하한 5%
  deadlineDays: number; // 7일 이상 → 기준가 게시 시점 확정(FIXED_AT_PUBLISH)
  priceKrw: number;
}

const CARDS: CardSpec[] = [
  { researcher: 'seller', ticker: '005930', direction: 'UP', targetValue: 12, deadlineDays: 90, priceKrw: 18_000 },
  { researcher: 'seller', ticker: '005930', direction: 'UP', targetValue: 8, deadlineDays: 45, priceKrw: 12_000 },
  { researcher: 'seller', ticker: '000660', direction: 'DOWN', targetValue: 10, deadlineDays: 60, priceKrw: 15_000 },
  { researcher: 'seller', ticker: '373220', direction: 'UP', targetValue: 15, deadlineDays: 120, priceKrw: 20_000 },
  { researcher: 'seller', ticker: '035420', direction: 'DOWN', targetValue: 8, deadlineDays: 60, priceKrw: 11_000 },
  { researcher: 'r1', ticker: '005930', direction: 'UP', targetValue: 10, deadlineDays: 75, priceKrw: 14_000 },
  { researcher: 'r1', ticker: '000660', direction: 'DOWN', targetValue: 12, deadlineDays: 90, priceKrw: 16_000 },
  { researcher: 'r1', ticker: '005380', direction: 'UP', targetValue: 9, deadlineDays: 100, priceKrw: 10_000 },
  { researcher: 'r1', ticker: '035720', direction: 'DOWN', targetValue: 7, deadlineDays: 45, priceKrw: 9_900 },
  { researcher: 'r1', ticker: '068270', direction: 'DOWN', targetValue: 10, deadlineDays: 80, priceKrw: 13_000 },
  { researcher: 'r2', ticker: '005930', direction: 'DOWN', targetValue: 6, deadlineDays: 30, priceKrw: 12_000 },
  { researcher: 'r2', ticker: '373220', direction: 'UP', targetValue: 10, deadlineDays: 60, priceKrw: 17_000 },
  { researcher: 'r2', ticker: '035720', direction: 'UP', targetValue: 8, deadlineDays: 90, priceKrw: 9_900 },
  { researcher: 'r2', ticker: '012450', direction: 'UP', targetValue: 20, deadlineDays: 150, priceKrw: 22_000 },
];

function krRegistry(): ProviderRegistry {
  const provider = new FixtureMarketDataProvider();
  for (const [ticker, { price }] of Object.entries(KR_STOCKS)) {
    provider.setCurrentPrice(ticker, price);
  }
  return { KR_EQUITY: provider };
}

async function main() {
  const already = await prisma.user.findUnique({ where: { email: EXTRA_RESEARCHERS[0].email } });
  if (already) {
    console.log('히트맵 데모 데이터가 이미 있습니다. 그대로 둡니다.');
    return;
  }

  const seller = await prisma.researcherProfile.findFirst({
    where: { user: { email: 'demo-researcher@test.io' } },
  });
  if (!seller) throw new Error('demo-researcher가 없습니다. 먼저 npm run seed:demo 를 실행하세요.');

  // 종목 마스터: 기존 활성 국내주식 유니버스에 데모 종목을 합쳐 반영
  // (applyInstrumentListings는 목록 밖 종목을 비활성화하므로 합집합으로 넘긴다)
  const existing = await prisma.instrument.findMany({
    where: { assetClass: 'KR_EQUITY', active: true },
    select: { ticker: true, name: true, currency: true },
  });
  const listings = new Map(existing.map((i) => [i.ticker, i]));
  for (const [ticker, { name }] of Object.entries(KR_STOCKS)) {
    listings.set(ticker, { ticker, name, currency: 'KRW' });
  }
  await applyInstrumentListings(prisma, 'KR_EQUITY', 'seed', [...listings.values()]);

  const ids: Record<CardSpec['researcher'], string> = { seller: seller.id, r1: '', r2: '' };
  for (const [i, spec] of EXTRA_RESEARCHERS.entries()) {
    const user = await prisma.user.create({
      data: {
        email: spec.email,
        penName: spec.penName,
        identityVerified: true,
        researcherProfile: { create: {} },
      },
      include: { researcherProfile: true },
    });
    ids[i === 0 ? 'r1' : 'r2'] = user.researcherProfile!.id;
  }

  const registry = krRegistry();
  const now = new Date();
  for (const card of CARDS) {
    const { name } = KR_STOCKS[card.ticker];
    const dirLabel = card.direction === 'UP' ? '상승' : '하락';
    const draft = await createDraftReport(
      prisma,
      {
        researcherId: ids[card.researcher],
        title: `${name} ${dirLabel} 시나리오`,
        summary: `${name} 수급·실적 분석 — ${card.targetValue}% ${dirLabel} 예측`,
        content: `${name}에 대한 상세 분석 본문입니다. 실적 추정과 수급 지표를 근거로 목표 구간을 제시합니다.`,
        priceKrw: card.priceKrw,
        prepaymentRatio: 0,
        card: {
          assetClass: 'KR_EQUITY',
          ticker: card.ticker,
          assetName: name,
          direction: card.direction,
          targetType: 'RETURN_PCT',
          targetValue: card.targetValue,
          deadline: new Date(now.getTime() + card.deadlineDays * 86_400_000),
          confidence: 3,
          selfStability: 6,
          selfProfitability: 7,
        },
      },
      now,
    );
    await publishReport(prisma, registry, draft.id, ids[card.researcher], now);
  }

  console.log(`히트맵 데모 시드 완료: 국내주식 활성 카드 ${CARDS.length}건 (리서처 3명 분산)`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
