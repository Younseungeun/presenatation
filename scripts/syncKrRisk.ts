import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { toRiskLevel } from '../src/domain/instrumentRisk';
import { KisMarketDataProvider } from '../src/infra/marketData/kisProvider';
import { setInstrumentRisk } from '../src/server/instrumentService';

// 국내 종목 위험 등급 동기화 — npm run risk:sync
//
// 시장경보(투자주의·경고·위험)·관리종목·정리매매는 KIS 현재가 응답에 함께 실려 온다
// (kisProvider.getRiskSignal, 2026-08-12 실측). 예전에는 "KRX 별도 소스라 운영자가
// 수동 등록"이었는데, 같은 호출로 얻을 수 있으니 자동으로 채운다.
//
// **전 종목을 돌지 않는다.** 2,684개를 초당 1회로 돌면 45분이 걸리고 대부분은 카드가
// 걸린 적도 없는 종목이다. 실제로 필요한 곳은 두 군데뿐이라 그 합집합만 본다:
//   · 지금 검증 중인 카드의 종목 — 판정 전에 상태가 바뀌면 알아야 한다
//   · 최근 게시된 카드의 종목 — 게시 검증(위험 등급)이 최신값을 봐야 한다
// 운영자가 수동 등록한 값(setInstrumentRisk)도 같은 자리를 쓰므로, 자동 갱신이
// 사람의 판단을 덮어쓴다. 그래서 **위험을 낮추는 방향(등급 하향)은 기록만 남기고
// 실제로는 내리지 않는다** — 사람이 올려 둔 경고를 기계가 지우면 안 된다.

const RECENT_DAYS = 30;

async function main() {
  const prisma = new PrismaClient();
  const { KIS_APP_KEY, KIS_APP_SECRET } = process.env;
  if (!KIS_APP_KEY || !KIS_APP_SECRET) throw new Error('KIS_APP_KEY/KIS_APP_SECRET가 없습니다');
  const kis = new KisMarketDataProvider(KIS_APP_KEY, KIS_APP_SECRET, 'KR');
  const now = new Date();

  const cards = await prisma.predictionCard.findMany({
    where: {
      assetClass: 'KR_EQUITY',
      OR: [
        { judgment: null, withdrawnAt: null, report: { status: 'PUBLISHED' } },
        { report: { publishedAt: { gte: new Date(now.getTime() - RECENT_DAYS * 86_400_000) } } },
      ],
    },
    select: { ticker: true },
  });
  const tickers = [...new Set(cards.map((c) => c.ticker))];
  console.log(`대상 종목 ${tickers.length}개 (검증 중 + 최근 ${RECENT_DAYS}일 게시)`);

  let changed = 0;
  let kept = 0;
  for (const ticker of tickers) {
    try {
      const signal = await kis.getRiskSignal(ticker);
      const next = toRiskLevel(signal);
      const current = await prisma.instrument.findUnique({
        where: { assetClass_ticker: { assetClass: 'KR_EQUITY', ticker } },
        select: { riskLevel: true, riskNote: true },
      });
      if (!current) continue;

      const order = ['NONE', 'CAUTION', 'WARNING', 'DANGER'];
      if (order.indexOf(next) < order.indexOf(current.riskLevel)) {
        // 사람이 올려 둔 경고를 기계가 내리지 않는다 — 눈에 보이게 남기고 넘어간다
        kept++;
        console.log(`  = ${ticker}: 현재 ${current.riskLevel} > 자동 ${next} — 유지(수동 등록 보호)`);
        continue;
      }
      if (next === current.riskLevel && (signal.note ?? null) === current.riskNote) continue;

      await setInstrumentRisk(prisma, 'KR_EQUITY', ticker, next, signal.note ?? null, {
        delistingRisk: signal.delisting,
      });
      changed++;
      console.log(`  ↑ ${ticker}: ${current.riskLevel} → ${next}${signal.note ? ` (${signal.note})` : ''}`);
    } catch (e) {
      console.error(`  ✗ ${ticker}: ${(e as Error).message}`);
    }
  }

  console.log(`완료 — 갱신 ${changed}건 / 수동값 유지 ${kept}건`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
