import 'dotenv/config';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { resolveProvider, toMarketDateString } from '../src/domain/marketData';
import type { AssetClass } from '../src/domain/constants';
import { realizedDailySigma } from '../src/domain/stability';

// σ 진단 — 측정값이 진짜인지 데이터 사고인지 가른다.
// 종가열·최대 등락일·표본 수를 그대로 찍어 눈으로 확인한다.

const TARGETS: Array<[AssetClass, string, string]> = [
  ['US_EQUITY', 'INTC', '인텔'],
  ['KR_EQUITY', '035420', 'NAVER'],
  ['US_EQUITY', 'JPM', 'JP모건'],
  ['KR_EQUITY', '005930', '삼성전자'],
];

async function main() {
  const registry = createDefaultRegistry();
  const now = new Date();

  for (const [assetClass, ticker, name] of TARGETS) {
    const provider = resolveProvider(registry, assetClass);
    const to = toMarketDateString(now, assetClass);
    const from = toMarketDateString(new Date(now.getTime() - 102 * 86_400_000), assetClass);
    const quotes = await provider.getDailyQuotes(ticker, from, to);
    const closes = quotes.map((q) => q.close);
    const sigma = realizedDailySigma(closes);

    const rets: Array<{ date: string; pct: number }> = [];
    for (let i = 1; i < quotes.length; i++) {
      rets.push({
        date: quotes[i].date,
        pct: (quotes[i].close / quotes[i - 1].close - 1) * 100,
      });
    }
    const worst = [...rets].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 5);

    console.log(`\n=== ${name} (${assetClass} ${ticker}) ===`);
    console.log(`구간 ${from} ~ ${to} / 일봉 ${quotes.length}개 / σ=${sigma === null ? 'null' : (sigma * 100).toFixed(2) + '%'}`);
    console.log(`  첫 3일: ${quotes.slice(0, 3).map((q) => `${q.date} ${q.close}`).join(' | ')}`);
    console.log(`  끝 3일: ${quotes.slice(-3).map((q) => `${q.date} ${q.close}`).join(' | ')}`);
    console.log(`  최대 등락 5일: ${worst.map((r) => `${r.date} ${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(1)}%`).join(' | ')}`);
    // 날짜가 연속 거래일인지 — 구멍이 크면 "하루 수익률"이 실제로는 여러 날치다
    const gaps = rets
      .map((r, i) => ({
        r,
        days: (Date.parse(r.date) - Date.parse(quotes[i].date)) / 86_400_000,
      }))
      .filter((g) => g.days > 4);
    console.log(`  4일 초과 공백: ${gaps.length}건 ${gaps.slice(0, 3).map((g) => `${g.r.date}(${g.days}일)`).join(' ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
