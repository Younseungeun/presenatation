// 실데이터 스모크 테스트 — 판정 파이프라인을 실제 시세로 실행해본다.
// 실행: npm run smoke:market
// ⚠️ Claude Code 원격 환경은 외부 시세 API가 네트워크 정책으로 차단되므로 로컬에서 실행할 것.
//    Stooq는 개발·검증 전용 소스다 (docs/market-data.md §3).

import { runJudgmentFromRegistry } from '../src/domain/judgmentPipeline';
import type { ProviderRegistry } from '../src/domain/marketData';
import { StooqMarketDataProvider } from '../src/infra/marketData/stooqProvider';
import { UpbitMarketDataProvider } from '../src/infra/marketData/upbitProvider';

const registry: ProviderRegistry = {
  US_EQUITY: new StooqMarketDataProvider(),
  CRYPTO: new UpbitMarketDataProvider(),
};

async function smokeUsEquity() {
  const quotes = await registry.US_EQUITY!.getDailyQuotes('AAPL', '2026-05-01', '2026-07-01');
  if (quotes.length === 0) throw new Error('Stooq에서 AAPL 일봉을 받지 못함');
  console.log(
    `[Stooq] AAPL 일봉 ${quotes.length}개 (${quotes[0].date} 종가 ${quotes[0].close} → ${quotes.at(-1)!.date} 종가 ${quotes.at(-1)!.close})`,
  );

  const { result, audit } = await runJudgmentFromRegistry(
    {
      assetClass: 'US_EQUITY',
      baseMode: 'FIXED_AT_PUBLISH',
      ticker: 'AAPL',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 5, // 게시일 종가 대비 +5% 예측
      basePrice: quotes[0].close,
      publishedAt: new Date('2026-05-01T13:30:00-04:00'),
      deadline: new Date('2026-07-01T16:00:00-04:00'),
    },
    registry,
  );
  console.log(`[판정] AAPL: ${result.outcome} (판정가 ${result.settledPrice}, 소스 ${audit.dataSource})`);
}

async function smokeCrypto() {
  const quotes = await registry.CRYPTO!.getDailyQuotes('KRW-BTC', '2026-06-01', '2026-07-10');
  if (quotes.length === 0) throw new Error('업비트에서 KRW-BTC 일봉을 받지 못함');
  console.log(
    `[업비트] KRW-BTC 일봉 ${quotes.length}개 (${quotes[0].date} 종가 ${quotes[0].close} → ${quotes.at(-1)!.date} 종가 ${quotes.at(-1)!.close})`,
  );

  const { result, audit } = await runJudgmentFromRegistry(
    {
      assetClass: 'CRYPTO',
      baseMode: 'FIXED_AT_PUBLISH',
      ticker: 'KRW-BTC',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 3,
      basePrice: quotes[0].close,
      publishedAt: new Date('2026-06-01T00:00:00+09:00'),
      deadline: new Date('2026-07-10T00:00:00+09:00'),
    },
    registry,
  );
  console.log(`[판정] KRW-BTC: ${result.outcome} (판정가 ${result.settledPrice}, 소스 ${audit.dataSource})`);
}

Promise.all([smokeUsEquity(), smokeCrypto()])
  .then(() => console.log('스모크 테스트 통과'))
  .catch((e) => {
    console.error('스모크 테스트 실패:', e.message);
    process.exit(1);
  });
