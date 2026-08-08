// 히트맵 색상 시나리오 시드 — 섹터별로 연관성 있는(추세를 따라가는) 예측 분포를 만들어
// 국내주식 히트맵에 다양한 색 단계가 표현되게 한다.
//  · 강세 섹터(전자 기술·생산자 제조·소비자 내구재 등): 대부분 상승, 일부 낙오 종목
//  · 약세 섹터(금융·의료 기술·비에너지 광물): 대부분 하락, 역행 1종목
//  · 혼조 섹터(기술 서비스·커뮤니케이션): 팽팽 포함
// 하락 카드는 전부 개별주식선물 유니버스(shortable) 종목만 사용.
// 브론즈 활성 카드 상한(자산군당 5장) 때문에 카드 5장마다 리서처를 새로 만든다.
// 실행: npm run seed:scenario   (이미 있으면 다시 만들지 않는다)
import { PrismaClient } from '@prisma/client';
import type { ProviderRegistry } from '../src/domain/marketData';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import { applyInstrumentListings } from '../src/server/instrumentService';
import { createDraftReport, publishReport } from '../src/server/reportService';

const prisma = new PrismaClient();

const MARKER_EMAIL = 'heatmap-scenario-1@test.io';

// 종목별 목표 분포 (up/down 건수) — 섹터 추세를 따라간다
const SCENARIO: { ticker: string; name: string; up: number; down: number }[] = [
  // 전자 기술 — 강세 (SK하이닉스만 낙오: 기존 ▼2에 ▲1 추가 → 하락 66%)
  { ticker: '000660', name: 'SK하이닉스', up: 1, down: 0 },
  { ticker: '009150', name: '삼성전기', up: 2, down: 0 },
  { ticker: '034220', name: 'LG디스플레이', up: 2, down: 1 },
  // 생산자 제조 — 강세 (삼성SDI만 팽팽)
  { ticker: '034020', name: '두산에너빌리티', up: 3, down: 0 },
  { ticker: '329180', name: 'HD현대중공업', up: 2, down: 1 },
  { ticker: '012330', name: '현대모비스', up: 1, down: 0 },
  { ticker: '006400', name: '삼성SDI', up: 1, down: 1 },
  // 금융 — 약세 (SK스퀘어만 역행)
  { ticker: '105560', name: 'KB금융', up: 0, down: 3 },
  { ticker: '055550', name: '신한지주', up: 1, down: 2 },
  { ticker: '086790', name: '하나금융지주', up: 0, down: 2 },
  { ticker: '316140', name: '우리금융지주', up: 0, down: 1 },
  { ticker: '323410', name: '카카오뱅크', up: 1, down: 1 },
  { ticker: '402340', name: 'SK스퀘어', up: 1, down: 0 },
  // 의료 기술 — 약세 (셀트리온 기존 ▼1에 ▼1 추가 → ▼2)
  { ticker: '068270', name: '셀트리온', up: 0, down: 1 },
  { ticker: '207940', name: '삼성바이오로직스', up: 1, down: 2 },
  // 기술 서비스 — 혼조 (NAVER 기존 ▼1에 ▲1 → 팽팽, 카카오는 기존 팽팽 유지)
  { ticker: '035420', name: 'NAVER', up: 1, down: 0 },
  { ticker: '259960', name: '크래프톤', up: 2, down: 0 },
  // 소비자 내구재 — 완만한 강세 (현대차 기존 ▲1에 ▲1▼1 → 상승 66%)
  { ticker: '005380', name: '현대차', up: 1, down: 1 },
  { ticker: '000270', name: '기아', up: 2, down: 0 },
  { ticker: '066570', name: 'LG전자', up: 1, down: 0 },
  // 커뮤니케이션 — 혼조
  { ticker: '017670', name: 'SK텔레콤', up: 1, down: 0 },
  { ticker: '030200', name: 'KT', up: 1, down: 1 },
  // 유틸리티 — 강세
  { ticker: '015760', name: '한국전력', up: 2, down: 0 },
  // 비에너지 광물 — 약세
  { ticker: '005490', name: 'POSCO홀딩스', up: 0, down: 2 },
  // 공정 산업 — 약세 우위 (하락 66%)
  { ticker: '051910', name: 'LG화학', up: 1, down: 2 },
  // 에너지 미네랄 — 약세
  { ticker: '096770', name: 'SK이노베이션', up: 0, down: 1 },
  // 산업 서비스·소비재 비내구재 — 소폭 강세
  { ticker: '028260', name: '삼성물산', up: 1, down: 0 },
  { ticker: '033780', name: 'KT&G', up: 1, down: 0 },
];

async function main() {
  const already = await prisma.user.findUnique({ where: { email: MARKER_EMAIL } });
  if (already) {
    console.log('히트맵 시나리오 데이터가 이미 있습니다. 그대로 둡니다.');
    return;
  }

  // 종목 마스터: 기존 활성 국내주식 유니버스에 시나리오 종목을 합쳐 반영
  const existing = await prisma.instrument.findMany({
    where: { assetClass: 'KR_EQUITY', active: true },
    select: { ticker: true, name: true, currency: true },
  });
  const listings = new Map(existing.map((i) => [i.ticker, i]));
  for (const s of SCENARIO) {
    listings.set(s.ticker, { ticker: s.ticker, name: s.name, currency: 'KRW' });
  }
  await applyInstrumentListings(prisma, 'KR_EQUITY', 'seed', [...listings.values()]);

  // 카드 목록으로 전개 (방향 섞기: up/down 교차로 넣어 리서처별 쏠림 방지)
  const cards: { ticker: string; name: string; direction: 'UP' | 'DOWN' }[] = [];
  for (const s of SCENARIO) {
    for (let i = 0; i < Math.max(s.up, s.down); i++) {
      if (i < s.up) cards.push({ ticker: s.ticker, name: s.name, direction: 'UP' });
      if (i < s.down) cards.push({ ticker: s.ticker, name: s.name, direction: 'DOWN' });
    }
  }

  // 기준가 픽스처 — 시세 값 자체는 데모라 중요하지 않다
  const provider = new FixtureMarketDataProvider();
  for (const s of SCENARIO) provider.setCurrentPrice(s.ticker, 100_000);
  const registry: ProviderRegistry = { KR_EQUITY: provider };

  // 브론즈 활성 상한(5장) — 5장마다 리서처를 새로 만든다
  const now = new Date();
  let researcherId = '';
  let used = 0;
  let researcherNo = 0;
  for (const [i, card] of cards.entries()) {
    if (used === 0) {
      researcherNo++;
      const user = await prisma.user.create({
        data: {
          email: `heatmap-scenario-${researcherNo}@test.io`,
          penName: `섹터워처${researcherNo}`,
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
          assetClass: 'KR_EQUITY',
          ticker: card.ticker,
          assetName: card.name,
          direction: card.direction,
          targetType: 'RETURN_PCT',
          targetValue: 6 + (i % 4) * 3, // 크기 하한 5% 이상
          deadline: new Date(now.getTime() + (30 + (i % 5) * 25) * 86_400_000),
          confidence: 3,
          selfStability: 6,
        },
      },
      now,
    );
    await publishReport(prisma, registry, draft.id, researcherId, now);
    used = (used + 1) % 5;
  }

  console.log(
    `히트맵 시나리오 시드 완료: 카드 ${cards.length}건, 종목 ${SCENARIO.length}개, 리서처 ${researcherNo}명`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
