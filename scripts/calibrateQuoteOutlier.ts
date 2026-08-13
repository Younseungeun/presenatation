import 'dotenv/config';
import { resolveProvider } from '../src/domain/marketData';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import type { AssetClass } from '../src/domain/constants';
import { estimateDailySigma } from '../src/domain/stability';

// 일봉 이상치 문턱 캘리브레이션 — npx tsx scripts/calibrateQuoteOutlier.ts
//
// ── 왜 필요한가 ──────────────────────────────────────────────
// 판정은 게시일~시한의 일봉 종가 극값이 목표를 넘었는지로 정한다. 시세 공급자가
// 하루치 종가를 잘못 주면(0, 자릿수 오류, 통화 혼동) **그 한 줄로 카드가 적중 판정**되고
// 구매자는 환불을 못 받는다. 권리 사건은 앵커 방식으로 이미 막혀 있지만
// (domain/corporateAction), 그것은 **과거 종가가 소급해 바뀌는 것**을 잡는 장치라
// 하루짜리 튀는 값은 걸러 내지 못한다.
//
// ── 문턱을 무엇으로 정하나 ───────────────────────────────────
// 국내주식은 **가격제한폭 ±30%가 거래소 규칙**이라 그걸 넘는 종가는 정의상 불가능하다 —
// 문턱을 고를 필요가 없다. 미국·코인은 상한이 없으므로 **그 종목의 σ 배수**로 잰다.
// 여기서 재는 것은 "진짜 급변이 σ의 몇 배까지 갔나"이고, 그보다 넉넉히 위에 문턱을 둬야
// 실제 사건(어닝 서프라이즈·바이오 임상·코인 급등)을 데이터 오류로 오인하지 않는다.

const FROM = 2019;
const TO = 2023;

const UNIVERSE: Record<AssetClass, string[]> = {
  KR_EQUITY: ['005930', '000660', '035420', '051910', '005380', '068270'],
  US_EQUITY: ['AAPL', 'MSFT', 'JPM', 'XOM', 'NVDA', 'DIS'],
  CRYPTO: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Hit {
  ticker: string;
  date: string;
  movePct: number;
  sigmaPct: number;
  ratio: number;
}

async function main() {
  console.log(`\n■ 일봉 이상치 문턱 — 실제 일봉 ${FROM}~${TO}`);
  console.log('  전일 종가 대비 로그 변화폭을, 그 시점까지의 σ(종가 120일 + Parkinson 10일)로 나눈다\n');
  const registry = createDefaultRegistry();

  for (const [assetClass, tickers] of Object.entries(UNIVERSE) as [AssetClass, string[]][]) {
    const provider = resolveProvider(registry, assetClass);
    const hits: Hit[] = [];
    let bars = 0;
    let overLimit = 0; // 국내 가격제한폭 초과

    for (const ticker of tickers) {
      const merged = new Map<string, { date: string; high: number; low: number; close: number; volume: number }>();
      for (let y = FROM; y <= TO; y++) {
        try {
          const chunk = await provider.getDailyQuotes(ticker, `${y}-01-01`, `${y}-12-31`);
          for (const b of chunk) {
            merged.set(b.date, {
              date: b.date,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume ?? 1,
            });
          }
        } catch {
          /* 그 해가 없으면 건너뛴다 */
        }
        if (assetClass === 'CRYPTO') await sleep(400);
      }
      const series = [...merged.values()]
        .filter((b) => b.close > 0 && b.high > 0 && b.low > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (series.length < 150) continue;
      process.stdout.write('.');

      for (let i = 121; i < series.length; i++) {
        const window = series.slice(i - 120, i);
        const sigma = estimateDailySigma(
          {
            closes: window.map((b) => b.close),
            highs: window.map((b) => b.high),
            lows: window.map((b) => b.low),
            volumes: window.map((b) => b.volume),
          },
          assetClass,
        );
        if (sigma == null || sigma <= 0) continue;
        bars++;
        const move = Math.log(series[i].close / series[i - 1].close);
        const ratio = Math.abs(move) / sigma;
        if (assetClass === 'KR_EQUITY' && Math.abs(Math.expm1(move)) > 0.3) overLimit++;
        hits.push({
          ticker,
          date: series[i].date,
          movePct: Math.expm1(move) * 100,
          sigmaPct: sigma * 100,
          ratio,
        });
      }
    }
    process.stdout.write('\n');

    hits.sort((a, b) => b.ratio - a.ratio);
    const q = (f: number) => hits[Math.floor(hits.length * f)]?.ratio ?? NaN;
    console.log(`\n  ── ${assetClass} — 일봉 ${bars.toLocaleString()}개 ──`);
    console.log(
      `  σ 배수 분위: p50 ${q(0.5).toFixed(1)} · p99 ${q(0.01).toFixed(1)} · p99.9 ${q(0.001).toFixed(1)} · 최대 ${hits[0]?.ratio.toFixed(1)}`,
    );
    if (assetClass === 'KR_EQUITY') {
      console.log(`  가격제한폭(±30%) 초과: ${overLimit}건 ${overLimit === 0 ? '← 규칙대로 한 건도 없다' : '← 데이터 확인 필요'}`);
    }
    console.log('  가장 큰 5건 (진짜 사건이다 — 이보다 위에 문턱을 둬야 한다):');
    for (const h of hits.slice(0, 5)) {
      console.log(
        `    ${h.date} ${h.ticker.padEnd(8)} ${h.movePct >= 0 ? '+' : ''}${h.movePct.toFixed(1)}%  (σ ${h.sigmaPct.toFixed(2)}% → ${h.ratio.toFixed(1)}배)`,
      );
    }
    for (const n of [6, 8, 10, 12]) {
      const over = hits.filter((h) => h.ratio > n).length;
      console.log(`    ${n}배 초과: ${over}건 (${((over / Math.max(1, bars)) * 100).toFixed(4)}%)`);
    }
  }
  console.log('');
}

main();
