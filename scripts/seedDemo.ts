// 데모용 종단 시드: 리서처 + 게시된 리포트 + 판정 이력을 만들어
// 리더보드·프로필·리포트 상세를 화면으로 검증할 수 있게 한다.
// 실행: npx tsx scripts/seedDemo.ts
import { PrismaClient } from '@prisma/client';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import type { ProviderRegistry } from '../src/domain/marketData';
import { judgeAndSettleDueCards } from '../src/server/judgmentBatch';
import { purchaseReport } from '../src/server/purchaseService';
import { createDraftReport, publishReport } from '../src/server/reportService';

const prisma = new PrismaClient();

function reg(ticker: string, current: number, deadlineClose: number): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, current).setQuotes(ticker, [
      { date: '2026-07-01', open: current, high: current, low: current, close: current, volume: 1 },
      {
        date: '2026-07-05',
        open: deadlineClose,
        high: Math.max(current, deadlineClose),
        low: Math.min(current, deadlineClose),
        close: deadlineClose,
        volume: 1,
      },
    ]),
  };
}

async function main() {
  const r = await prisma.user.upsert({
    where: { email: 'demo-researcher@test.io' },
    update: {},
    create: {
      email: 'demo-researcher@test.io',
      penName: '크립토애널리스트',
      identityVerified: true,
      researcherProfile: { create: { careerBadge: 'ANALYST' } },
    },
    include: { researcherProfile: true },
  });
  const researcherId = r.researcherProfile!.id;
  const buyer = await prisma.user.upsert({
    where: { email: 'demo-buyer@test.io' },
    update: {},
    create: { email: 'demo-buyer@test.io', penName: '데모구매자', identityVerified: true },
  });

  const publishAt = new Date('2026-07-01T00:00:00Z');
  const past = (ticker: string, name: string, current: number, close: number, tv: number) =>
    createDraftReport(
      prisma,
      {
        researcherId,
        title: `${name} 단기 전망`,
        summary: `${name} 기술적 분석 기반 예측`,
        content: `${name}에 대한 상세 분석 본문입니다. 지지선/저항선과 온체인 지표를 근거로...`,
        priceKrw: 12000,
        prepaymentRatio: 0,
        card: {
          assetClass: 'CRYPTO',
          ticker,
          assetName: name,
          direction: 'UP',
          targetType: 'RETURN_PCT',
          targetValue: tv,
          deadline: new Date('2026-07-05T00:00:00Z'),
          confidence: 4,
          selfStability: 6,
          selfProfitability: 7,
        },
      },
      publishAt,
    ).then(async (draft) => {
      await publishReport(prisma, reg(ticker, current, close), draft.id, researcherId, publishAt);
      await purchaseReport(prisma, draft.id, buyer.id, publishAt);
      return draft.id;
    });

  await past('KRW-BTC', '비트코인', 100_000_000, 115_000_000, 10); // +15% → HIT
  await past('KRW-ETH', '이더리움', 5_000_000, 4_600_000, 12); // -8% → MISS

  // 판정 배치 실행 (시한 지난 것으로 판정)
  const batchNow = new Date('2026-07-06T00:00:00Z');
  const summary = await judgeAndSettleDueCards(
    prisma,
    {
      CRYPTO: new FixtureMarketDataProvider()
        .setQuotes('KRW-BTC', [
          { date: '2026-07-01', open: 1, high: 1, low: 1, close: 100_000_000, volume: 1 },
          { date: '2026-07-05', open: 1, high: 115_000_000, low: 1, close: 115_000_000, volume: 1 },
        ])
        .setQuotes('KRW-ETH', [
          { date: '2026-07-01', open: 1, high: 1, low: 1, close: 5_000_000, volume: 1 },
          { date: '2026-07-05', open: 1, high: 1, low: 1, close: 4_600_000, volume: 1 },
        ]),
    },
    batchNow,
  );

  // 판매 중(미판정) 리포트 하나 추가
  const live = await createDraftReport(
    prisma,
    {
      researcherId,
      title: '솔라나 반등 시나리오',
      summary: '솔라나 생태계 지표 개선 — 3개월 상승 예측',
      content: '솔라나 본문 (구매 후 열람)',
      priceKrw: 20000,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker: 'KRW-SOL',
        assetName: '솔라나',
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 20,
        deadline: new Date('2026-10-01T00:00:00Z'),
        confidence: 3,
        selfStability: 5,
        selfProfitability: 8,
      },
    },
    new Date(),
  );
  await publishReport(prisma, reg('KRW-SOL', 250_000, 250_000), live.id, researcherId);

  console.log(`시드 완료: 판정 ${summary.judged}건, researcherId=${researcherId}`);
}

main().finally(() => prisma.$disconnect());
