// 미국주식 히트맵 색상 시나리오 시드 — 국내주식(seedHeatmapScenario)과 같은 방식.
//  · 강세: 전자 기술(인텔만 낙오)·금융·에너지
//  · 약세: 소비자 내구재(홈디포만 역행)·의료 기술(J&J 역행)
//  · 혼조: 커뮤니케이션·생산자 제조
// 하락 카드는 전부 인버스 싱글스톡 ETF 유니버스(shortable) 종목만 사용.
// 브론즈 활성 카드 상한(자산군당 5장) 때문에 카드 5장마다 리서처를 새로 만든다.
// 실행: npm run seed:us   (이미 있으면 다시 만들지 않는다)
import { PrismaClient } from '@prisma/client';
import type { ProviderRegistry } from '../src/domain/marketData';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import { applyInstrumentListings } from '../src/server/instrumentService';
import { createDraftReport, publishReport } from '../src/server/reportService';

const prisma = new PrismaClient();

const MARKER_EMAIL = 'heatmap-us-1@test.io';

// 종목별 목표 분포 (up/down 건수) — 섹터 추세를 따라간다
const SCENARIO: { ticker: string; name: string; up: number; down: number }[] = [
  // 전자 기술 — 강세 (인텔만 낙오)
  { ticker: 'NVDA', name: 'NVIDIA', up: 3, down: 1 },
  { ticker: 'AAPL', name: 'Apple', up: 2, down: 0 },
  { ticker: 'MSFT', name: 'Microsoft', up: 2, down: 1 },
  { ticker: 'AVGO', name: 'Broadcom', up: 2, down: 0 },
  { ticker: 'AMD', name: 'AMD', up: 1, down: 1 },
  { ticker: 'INTC', name: 'Intel', up: 0, down: 2 },
  // 커뮤니케이션 — 혼조
  { ticker: 'GOOGL', name: 'Alphabet', up: 2, down: 0 },
  { ticker: 'META', name: 'Meta Platforms', up: 1, down: 1 },
  { ticker: 'NFLX', name: 'Netflix', up: 0, down: 1 },
  // 소비자 내구재 — 약세 (홈디포만 역행)
  { ticker: 'TSLA', name: 'Tesla', up: 1, down: 2 },
  { ticker: 'AMZN', name: 'Amazon', up: 0, down: 2 },
  { ticker: 'HD', name: 'Home Depot', up: 1, down: 0 },
  // 금융 — 강세
  { ticker: 'JPM', name: 'JPMorgan Chase', up: 2, down: 0 },
  { ticker: 'V', name: 'Visa', up: 1, down: 0 },
  { ticker: 'MA', name: 'Mastercard', up: 1, down: 0 },
  { ticker: 'BAC', name: 'Bank of America', up: 1, down: 0 },
  // 생산자 제조 — 혼조 (보잉 약세)
  { ticker: 'GE', name: 'GE Aerospace', up: 2, down: 0 },
  { ticker: 'CAT', name: 'Caterpillar', up: 1, down: 0 },
  { ticker: 'BA', name: 'Boeing', up: 0, down: 2 },
  // 의료 기술 — 약세 소폭 (J&J 역행)
  { ticker: 'LLY', name: 'Eli Lilly', up: 1, down: 2 },
  { ticker: 'JNJ', name: 'Johnson & Johnson', up: 1, down: 0 },
  // 에너지·소비재·유틸리티 — 소폭 강세
  { ticker: 'XOM', name: 'ExxonMobil', up: 1, down: 0 },
  { ticker: 'WMT', name: 'Walmart', up: 1, down: 0 },
  { ticker: 'NEE', name: 'NextEra Energy', up: 1, down: 0 },
];

async function main() {
  const already = await prisma.user.findUnique({ where: { email: MARKER_EMAIL } });
  if (already) {
    console.log('미국주식 시나리오 데이터가 이미 있습니다. 그대로 둡니다.');
    return;
  }

  // 종목 마스터: 기존 활성 미국주식 유니버스에 시나리오 종목을 합쳐 반영
  const existing = await prisma.instrument.findMany({
    where: { assetClass: 'US_EQUITY', active: true },
    select: { ticker: true, name: true, currency: true },
  });
  const listings = new Map(existing.map((i) => [i.ticker, i]));
  for (const s of SCENARIO) {
    listings.set(s.ticker, { ticker: s.ticker, name: s.name, currency: 'USD' });
  }
  await applyInstrumentListings(prisma, 'US_EQUITY', 'seed', [...listings.values()]);

  // 카드 목록으로 전개
  const cards: { ticker: string; name: string; direction: 'UP' | 'DOWN' }[] = [];
  for (const s of SCENARIO) {
    for (let i = 0; i < Math.max(s.up, s.down); i++) {
      if (i < s.up) cards.push({ ticker: s.ticker, name: s.name, direction: 'UP' });
      if (i < s.down) cards.push({ ticker: s.ticker, name: s.name, direction: 'DOWN' });
    }
  }

  // 기준가 픽스처 — 시세 값 자체는 데모라 중요하지 않다
  const provider = new FixtureMarketDataProvider();
  for (const s of SCENARIO) provider.setCurrentPrice(s.ticker, 300);
  const registry: ProviderRegistry = { US_EQUITY: provider };

  const now = new Date();
  let researcherId = '';
  let used = 0;
  let researcherNo = 0;
  for (const [i, card] of cards.entries()) {
    if (used === 0) {
      researcherNo++;
      const user = await prisma.user.create({
        data: {
          email: `heatmap-us-${researcherNo}@test.io`,
          penName: `US워처${researcherNo}`,
          identityVerified: true,
          researcherProfile: { create: {} },
        },
        include: { researcherProfile: true },
      });
      researcherId = user.researcherProfile!.id;
    }
    const dirLabel = card.direction === 'UP' ? '상승' : '하락';
    const draft = await createDraftReport(
      prisma,
      {
        researcherId,
        title: `${card.name} ${dirLabel} 시나리오 #${i + 1}`,
        summary: `${card.name} 섹터 흐름 분석 — ${dirLabel} 예측`,
        content: `${card.name}에 대한 상세 분석 본문입니다. 섹터 수급과 실적 추정을 근거로 목표 구간을 제시합니다.`,
        priceKrw: 9_900 + (i % 5) * 2_000,
        prepaymentRatio: 0,
        card: {
          assetClass: 'US_EQUITY',
          ticker: card.ticker,
          assetName: card.name,
          direction: card.direction,
          targetType: 'RETURN_PCT',
          targetValue: 6 + (i % 4) * 3, // 크기 하한 5% 이상
          deadline: new Date(now.getTime() + (30 + (i % 5) * 25) * 86_400_000),
          confidence: 3,
          selfStability: 6,
          selfProfitability: 7,
        },
      },
      now,
    );
    await publishReport(prisma, registry, draft.id, researcherId, now);
    used = (used + 1) % 5;
  }

  console.log(
    `미국주식 시나리오 시드 완료: 카드 ${cards.length}건, 종목 ${SCENARIO.length}개, 리서처 ${researcherNo}명`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
