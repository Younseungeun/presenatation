import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { isLeveragedProduct } from '../src/domain/leveragedProduct';
import { resolveProvider, toMarketDateString, type DailyQuote } from '../src/domain/marketData';
import { realizedDailySigma, STABILITY_SIGMA_BOUNDS } from '../src/domain/stability';
import { fetchUsListings } from '../src/infra/marketData/nasdaqTrader';
import { createDefaultRegistry } from '../src/infra/marketData/registry';

// 안정성 눈금 캘리브레이션 — npm run calibrate:stability
//
// ── 2026-08-13 재설계 (표본 126 → 500+, 규모 계층화) ────────────────
// 이전 판은 자산군마다 무작위 표본을 뽑아 그대로 5분위를 냈다. 문제가 둘이었다:
//  ① 표본이 작다 (126종목) — 5분위 경계의 표준오차가 커서 별 한 칸이 흔들린다
//  ② **규모가 고르지 않다** — 유니버스의 대다수가 소형주라 무작위 표본은 소형주로
//     채워지고, 눈금이 소형주 기준으로 밀린다. 그러면 사람들이 실제로 거래하는
//     대형주가 전부 위쪽 한두 칸에 뭉쳐 별점이 변별력을 잃는다
//
// **시가총액은 마스터에 없다** (Instrument.marketCap 전 종목 null — 실측 확인).
// 대신 **거래대금(종가×거래량의 중앙값)** 으로 계층을 나눈다. σ를 재려고 어차피 받는
// 일봉에서 공짜로 나오고, 우리 목적에는 시총보다 낫다 — 안정성 별점이 답해야 하는
// 질문은 "구매자가 이 종목을 들고 있을 때 얼마나 흔들리나"인데, 거래대금은 그
// 구매자가 실제로 접근할 수 있는 종목인지까지 함께 말해 준다.
// 미국은 나스닥이 주는 **Market Category**(Q 글로벌셀렉트 / G 글로벌 / S 캐피털)도
// 함께 본다 — 상장 요건 등급이라 규모의 직접적인 대리변수다.
//
// 계층마다 **같은 수만큼** 뽑아, 눈금이 유니버스의 종목 수 분포가 아니라
// 규모 전 구간을 고르게 반영하게 한다.

/** 계층(거래대금 5분위)마다 이만큼씩 — 자산군당 5 × 이 값 */
const PER_STRATUM: Record<AssetClass, number> = {
  KR_EQUITY: 30,
  US_EQUITY: 30,
  CRYPTO: 20,
};

/** 계층을 나누기 위해 먼저 훑어볼 후보 수 (이 중에서 계층별로 뽑는다) */
const SCREEN_POOL: Record<AssetClass, number> = {
  KR_EQUITY: 150,
  US_EQUITY: 150,
  CRYPTO: 100,
};

const ANCHORS: Array<[AssetClass, string, string]> = [
  ['KR_EQUITY', '005930', '삼성전자'],
  ['KR_EQUITY', '035420', 'NAVER'],
  ['KR_EQUITY', '005380', '현대차'],
  ['KR_EQUITY', '000660', 'SK하이닉스'],
  ['US_EQUITY', 'JPM', 'JP모건'],
  ['US_EQUITY', 'INTC', '인텔'],
  ['US_EQUITY', 'NVDA', '엔비디아'],
  ['US_EQUITY', 'KO', '코카콜라'],
  ['CRYPTO', 'KRW-BTC', '비트코인'],
  ['CRYPTO', 'KRW-ETH', '이더리움'],
  ['CRYPTO', 'KRW-DOGE', '도지코인'],
];

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function levelWith(bounds: readonly number[], sigma: number): number {
  let level = 5;
  for (const b of bounds) if (sigma >= b) level--;
  return level;
}

/** 일거래대금 중앙값 — 규모 대리변수. 통화가 섞이지만 계층은 자산군 안에서만 나눈다 */
function medianTurnover(quotes: DailyQuote[]): number {
  const v = quotes.map((q) => q.close * q.volume).filter((x) => Number.isFinite(x) && x > 0);
  if (v.length === 0) return 0;
  return v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
}

interface Measured {
  assetClass: AssetClass;
  ticker: string;
  name: string;
  sigma: number;
  turnover: number;
  /** 미국만 — 나스닥 상장 등급 (Q/G/S) 또는 NYSE */
  tier?: string;
}

async function main() {
  const prisma = new PrismaClient();
  const registry = createDefaultRegistry();
  const now = new Date();
  const random = rng(20260813);

  // 미국 상장 등급 — 규모 계층의 직접 근거 (무료·무인증)
  let usTier = new Map<string, string>();
  try {
    const listings = await fetchUsListings();
    usTier = new Map(
      listings.map((l) => [
        l.ticker,
        l.marketCategory ? `NASDAQ-${l.marketCategory}` : (l.exchange ?? 'OTHER'),
      ]),
    );
    console.log(`미국 상장 등급 로드: ${usTier.size}종목`);
  } catch (e) {
    console.log(`미국 상장 등급 로드 실패 — 거래대금 계층만 씁니다 (${(e as Error).message})`);
  }

  const measured: Measured[] = [];
  let skippedLeverage = 0;
  let failed = 0;

  for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    const all = await prisma.instrument.findMany({
      where: { assetClass, active: true },
      select: { ticker: true, name: true },
    });
    const pool = all.filter((i) => {
      if (isLeveragedProduct(i.name, i.ticker)) {
        skippedLeverage++;
        return false;
      }
      return true;
    });

    const anchors = ANCHORS.filter(([ac]) => ac === assetClass).map(([, ticker, name]) => ({
      ticker,
      name,
    }));
    const screened = [...pool]
      .sort(() => random() - 0.5)
      .slice(0, SCREEN_POOL[assetClass])
      .filter((s) => !anchors.some((a) => a.ticker === s.ticker));
    const targets = [...anchors, ...screened];

    console.log(
      `\n[${assetClass}] 마스터 ${all.length} → 레버리지 제외 ${pool.length} → 조회 ${targets.length}`,
    );

    const provider = resolveProvider(registry, assetClass);
    const to = toMarketDateString(now, assetClass);
    const from = toMarketDateString(new Date(now.getTime() - 102 * 86_400_000), assetClass);

    let done = 0;
    for (const t of targets) {
      try {
        const quotes = await provider.getDailyQuotes(t.ticker, from, to);
        const sigma = realizedDailySigma(quotes.map((q) => q.close));
        if (sigma === null) {
          failed++;
        } else {
          measured.push({
            assetClass,
            ticker: t.ticker,
            name: t.name,
            sigma,
            turnover: medianTurnover(quotes),
            tier: assetClass === 'US_EQUITY' ? usTier.get(t.ticker) : undefined,
          });
        }
      } catch {
        failed++;
      }
      if (++done % 25 === 0) console.log(`  ...${done}/${targets.length}`);
    }
    console.log(`  측정 ${measured.filter((m) => m.assetClass === assetClass).length}종목`);
  }

  // ── 규모 계층화: 자산군 안에서 거래대금 5분위 → 계층마다 같은 수만 남긴다 ──
  const stratified: Measured[] = [];
  for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    const rows = measured.filter((m) => m.assetClass === assetClass);
    if (rows.length === 0) continue;
    const cuts = [0.2, 0.4, 0.6, 0.8].map((q) =>
      quantile([...rows.map((r) => r.turnover)].sort((a, b) => a - b), q),
    );
    const bucketOf = (t: number) => cuts.filter((c) => t >= c).length; // 0(최소)~4(최대)
    for (let b = 0; b <= 4; b++) {
      const inBucket = rows.filter((r) => bucketOf(r.turnover) === b);
      stratified.push(...inBucket.slice(0, PER_STRATUM[assetClass]));
    }
  }

  const report = (label: string, rows: Measured[]) => {
    const sorted = rows.map((r) => r.sigma).sort((a, b) => a - b);
    console.log(`\n=== ${label} (n=${sorted.length}) ===`);
    for (const q of [0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.95]) {
      console.log(`  p${String(Math.round(q * 100)).padStart(2)}: ${(quantile(sorted, q) * 100).toFixed(2)}%`);
    }
    return sorted;
  };

  report('무작위 표본 전체 (계층화 전)', measured);
  const sorted = report('**규모 계층화 표본** (거래대금 5분위 균등)', stratified);

  console.log('\n--- 자산군별 ---');
  for (const ac of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    const s = stratified.filter((m) => m.assetClass === ac).map((m) => m.sigma).sort((a, b) => a - b);
    if (s.length === 0) continue;
    console.log(
      `  ${ac.padEnd(11)} n=${String(s.length).padStart(3)}  중앙값 ${(quantile(s, 0.5) * 100).toFixed(2)}%  p20 ${(quantile(s, 0.2) * 100).toFixed(2)}%  p80 ${(quantile(s, 0.8) * 100).toFixed(2)}%`,
    );
  }

  console.log('\n--- 거래대금 계층별 σ 중앙값 (규모가 클수록 조용한가) ---');
  for (const ac of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    const rows = measured.filter((m) => m.assetClass === ac);
    if (rows.length === 0) continue;
    const cuts = [0.2, 0.4, 0.6, 0.8].map((q) =>
      quantile([...rows.map((r) => r.turnover)].sort((a, b) => a - b), q),
    );
    const bucketOf = (t: number) => cuts.filter((c) => t >= c).length;
    const cells = [0, 1, 2, 3, 4].map((b) => {
      const s = rows.filter((r) => bucketOf(r.turnover) === b).map((r) => r.sigma).sort((a, b2) => a - b2);
      return s.length ? `${(quantile(s, 0.5) * 100).toFixed(1)}%(n${s.length})` : '—';
    });
    console.log(`  ${ac.padEnd(11)} 소형→대형: ${cells.join('  ')}`);
  }

  const usByTier = new Map<string, number[]>();
  for (const m of stratified.filter((m) => m.assetClass === 'US_EQUITY' && m.tier)) {
    const arr = usByTier.get(m.tier!) ?? [];
    arr.push(m.sigma);
    usByTier.set(m.tier!, arr);
  }
  if (usByTier.size > 0) {
    console.log('\n--- 미국 상장 등급별 σ 중앙값 (Q 글로벌셀렉트 = 최상위) ---');
    for (const [tier, arr] of [...usByTier].sort()) {
      const s = arr.sort((a, b) => a - b);
      console.log(`  ${tier.padEnd(12)} n=${String(s.length).padStart(3)}  중앙값 ${(quantile(s, 0.5) * 100).toFixed(2)}%`);
    }
  }

  // ── 제안 경계 ────────────────────────────────────────────────
  const proposed = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(sorted, q));
  const rounded = proposed.map((v) => Number((Math.round(v * 2000) / 2000).toFixed(4)));
  console.log('\n=== 제안 경계 (계층화 표본의 5분위, 0.05%p 격자) ===');
  console.log(`  현재: ${STABILITY_SIGMA_BOUNDS.map((b) => (b * 100).toFixed(2) + '%').join(' / ')}`);
  console.log(`  제안: ${rounded.map((b) => (b * 100).toFixed(2) + '%').join(' / ')}`);

  const dist = (bounds: readonly number[], rows: Measured[]) => {
    const counts = [0, 0, 0, 0, 0];
    for (const m of rows) counts[levelWith(bounds, m.sigma) - 1]++;
    return counts.map((c, i) => `★${i + 1}:${((c / rows.length) * 100).toFixed(0)}%`).join(' ');
  };
  console.log(`  현재 점유율: ${dist(STABILITY_SIGMA_BOUNDS, stratified)}`);
  console.log(`  제안 점유율: ${dist(rounded, stratified)}`);

  console.log('\n=== 익숙한 이름들 ===');
  for (const [, ticker] of ANCHORS) {
    const m = measured.find((x) => x.ticker === ticker);
    if (!m) {
      console.log(`  ${ticker}: 측정 실패`);
      continue;
    }
    console.log(
      `  ${m.name.padEnd(9)} σ=${(m.sigma * 100).toFixed(2)}%  현재 ★${levelWith(STABILITY_SIGMA_BOUNDS, m.sigma)} → 제안 ★${levelWith(rounded, m.sigma)}`,
    );
  }

  const byS = [...stratified].sort((a, b) => a.sigma - b.sigma);
  console.log(`\n  가장 조용: ${byS.slice(0, 5).map((m) => `${m.name}(${(m.sigma * 100).toFixed(1)}%)`).join(' ')}`);
  console.log(`  가장 거침: ${byS.slice(-5).map((m) => `${m.name}(${(m.sigma * 100).toFixed(1)}%)`).join(' ')}`);
  console.log(`\n  조회 실패·표본 부족 ${failed} / 레버리지 제외 ${skippedLeverage}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
