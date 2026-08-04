// 코인 히트맵 색상 시나리오 시드 — 국내·미국주식 시나리오와 같은 방식.
//  · 강세: 가치 저장·결제(BTC), 스마트 컨트랙트(SOL·수이), 인프라(체인링크)
//  · 약세: 밈(도지·시바이누·페페), 게임·메타버스
//  · 혼조: 이더리움·에이다·카이아 팽팽
// 코인은 하락 예측 제한이 없다(전 종목 숏 가능). 크기 하한은 10%(코인 규칙).
// 기존 활성 카드(BTC ▲1, ETH ▲1, SOL ▲2)에 얹어 최종 분포를 만든다.
// 실행: npm run seed:crypto   (이미 있으면 다시 만들지 않는다)
import { PrismaClient } from '@prisma/client';
import type { ProviderRegistry } from '../src/domain/marketData';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import { applyInstrumentListings } from '../src/server/instrumentService';
import { createDraftReport, publishReport } from '../src/server/reportService';

const prisma = new PrismaClient();

const MARKER_EMAIL = 'heatmap-crypto-1@test.io';

// 종목별 "추가" 분포 (기존 활성 카드 위에 얹힌다)
const SCENARIO: { ticker: string; name: string; up: number; down: number }[] = [
  // 가치 저장·결제 — 강세 (기존 BTC ▲1 → 최종 ▲3▼1 = 75%)
  { ticker: 'KRW-BTC', name: '비트코인', up: 2, down: 1 },
  // 스마트 컨트랙트 — 강세, 이더리움만 팽팽 (기존 ETH ▲1 → ▲1▼1)
  { ticker: 'KRW-ETH', name: '이더리움', up: 0, down: 1 },
  { ticker: 'KRW-SOL', name: '솔라나', up: 1, down: 0 }, // 기존 ▲2 → ▲3 100%
  { ticker: 'KRW-ADA', name: '에이다', up: 1, down: 1 },
  { ticker: 'KRW-SUI', name: '수이', up: 2, down: 1 },
  { ticker: 'KRW-AVAX', name: '아발란체', up: 0, down: 1 },
  // 결제·송금 — 강세
  { ticker: 'KRW-XRP', name: '엑스알피(리플)', up: 2, down: 0 },
  // 밈 — 약세
  { ticker: 'KRW-DOGE', name: '도지코인', up: 0, down: 2 },
  { ticker: 'KRW-SHIB', name: '시바이누', up: 0, down: 1 },
  { ticker: 'KRW-PEPE', name: '페페', up: 1, down: 2 },
  // 인프라·오라클 — 강세
  { ticker: 'KRW-LINK', name: '체인링크', up: 2, down: 0 },
  // 레이어2 — 혼조
  { ticker: 'KRW-ARB', name: '아비트럼', up: 1, down: 1 },
  // 게임·메타버스 — 약세
  { ticker: 'KRW-SAND', name: '샌드박스', up: 0, down: 1 },
];

async function main() {
  const already = await prisma.user.findUnique({ where: { email: MARKER_EMAIL } });
  if (already) {
    console.log('코인 시나리오 데이터가 이미 있습니다. 그대로 둡니다.');
    return;
  }

  // 종목 마스터: 기존 활성 코인 유니버스에 시나리오 종목을 합쳐 반영
  const existing = await prisma.instrument.findMany({
    where: { assetClass: 'CRYPTO', active: true },
    select: { ticker: true, name: true, currency: true },
  });
  const listings = new Map(existing.map((i) => [i.ticker, i]));
  for (const s of SCENARIO) {
    listings.set(s.ticker, { ticker: s.ticker, name: s.name, currency: 'KRW' });
  }
  await applyInstrumentListings(prisma, 'CRYPTO', 'seed', [...listings.values()]);

  // 카드 목록으로 전개
  const cards: { ticker: string; name: string; direction: 'UP' | 'DOWN' }[] = [];
  for (const s of SCENARIO) {
    for (let i = 0; i < Math.max(s.up, s.down); i++) {
      if (i < s.up) cards.push({ ticker: s.ticker, name: s.name, direction: 'UP' });
      if (i < s.down) cards.push({ ticker: s.ticker, name: s.name, direction: 'DOWN' });
    }
  }

  // 기준가 픽스처 — 코인은 게시 순간 실시간 현재가가 기준가
  const provider = new FixtureMarketDataProvider();
  for (const s of SCENARIO) provider.setCurrentPrice(s.ticker, 1_000_000);
  const registry: ProviderRegistry = { CRYPTO: provider };

  const now = new Date();
  let researcherId = '';
  let used = 0;
  let researcherNo = 0;
  for (const [i, card] of cards.entries()) {
    if (used === 0) {
      researcherNo++;
      const user = await prisma.user.create({
        data: {
          email: `heatmap-crypto-${researcherNo}@test.io`,
          penName: `코인워처${researcherNo}`,
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
        summary: `${card.name} 온체인·수급 분석 — ${dirLabel} 예측`,
        content: `${card.name}에 대한 상세 분석 본문입니다. 온체인 지표와 파생 수급을 근거로 목표 구간을 제시합니다.`,
        priceKrw: 9_900 + (i % 5) * 2_000,
        prepaymentRatio: 0,
        card: {
          assetClass: 'CRYPTO',
          ticker: card.ticker,
          assetName: card.name,
          direction: card.direction,
          targetType: 'RETURN_PCT',
          targetValue: 12 + (i % 4) * 4, // 코인 크기 하한 10% 이상
          deadline: new Date(now.getTime() + (20 + (i % 5) * 20) * 86_400_000),
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
    `코인 시나리오 시드 완료: 카드 ${cards.length}건, 종목 ${SCENARIO.length}개, 리서처 ${researcherNo}명`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
