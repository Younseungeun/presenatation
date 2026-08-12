import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { isLeveragedProduct } from '../src/domain/leveragedProduct';
import { resolveProvider, toMarketDateString } from '../src/domain/marketData';
import { realizedDailySigma, STABILITY_SIGMA_BOUNDS } from '../src/domain/stability';
import { createDefaultRegistry } from '../src/infra/marketData/registry';

// 안정성 눈금 캘리브레이션 — 종목 마스터에서 무작위 표본을 뽑아 실제 σ 분포를 재고,
// 그 분포의 5분위로 경계를 제안한다.
//
// 왜 무작위 표본인가: 카드에 쓸 수 있는 종목은 마스터 전체다. 대형주만 재면 눈금이
// 대형주 기준이 되어 소형주가 전부 바닥 한 칸에 뭉친다(반대로 대형주만 바닥에
// 떨어지던 것이 지금 문제였다). 레버리지·인버스만 뺀다 — 설계상 2~3배로 움직여
// 분포의 꼬리를 혼자 끌고 가기 때문.

const PER_CLASS: Record<AssetClass, number> = {
  KR_EQUITY: 55,
  US_EQUITY: 55,
  CRYPTO: 40,
};

/** 눈에 익은 이름들이 어디에 떨어지는지 — 눈금이 상식과 맞는지 보는 기준점 */
const ANCHORS: Array<[AssetClass, string, string]> = [
  ['KR_EQUITY', '005930', '삼성전자'],
  ['KR_EQUITY', '035420', 'NAVER'],
  ['KR_EQUITY', '005380', '현대차'],
  ['US_EQUITY', 'JPM', 'JP모건'],
  ['US_EQUITY', 'INTC', '인텔'],
  ['US_EQUITY', 'NVDA', '엔비디아'],
  ['CRYPTO', 'KRW-BTC', '비트코인'],
  ['CRYPTO', 'KRW-DOGE', '도지코인'],
];

/** 재현 가능한 난수 (mulberry32) — 표본이 매번 달라지면 결과를 비교할 수 없다 */
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
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 주어진 경계로 별 구간 — stabilityLevel과 같은 규칙 */
function levelWith(bounds: readonly number[], sigma: number): number {
  let level = 5;
  for (const b of bounds) if (sigma >= b) level--;
  return level;
}

async function main() {
  const prisma = new PrismaClient();
  const registry = createDefaultRegistry();
  const now = new Date();
  const random = rng(20260812);

  const measured: Array<{ assetClass: AssetClass; ticker: string; name: string; sigma: number }> =
    [];
  let leverageSkipped = 0;
  let noSample = 0;

  for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    const all = await prisma.instrument.findMany({
      where: { assetClass, active: true },
      select: { ticker: true, name: true },
    });
    const pool = all.filter((i) => {
      if (isLeveragedProduct(i.name, i.ticker)) {
        leverageSkipped++;
        return false;
      }
      return true;
    });

    // 무작위 표본 (앵커는 따로 반드시 포함)
    const shuffled = [...pool].sort(() => random() - 0.5).slice(0, PER_CLASS[assetClass]);
    const anchors = ANCHORS.filter(([ac]) => ac === assetClass).map(([, ticker, name]) => ({
      ticker,
      name,
    }));
    const targets = [...anchors, ...shuffled.filter((s) => !anchors.some((a) => a.ticker === s.ticker))];

    console.log(
      `\n[${assetClass}] 마스터 ${all.length}종목 → 레버리지 제외 ${pool.length} → 표본 ${targets.length}`,
    );

    const provider = resolveProvider(registry, assetClass);
    const to = toMarketDateString(now, assetClass);
    const from = toMarketDateString(new Date(now.getTime() - 102 * 86_400_000), assetClass);

    for (const t of targets) {
      try {
        const quotes = await provider.getDailyQuotes(t.ticker, from, to);
        const sigma = realizedDailySigma(quotes.map((q) => q.close));
        if (sigma === null) {
          noSample++;
          continue;
        }
        measured.push({ assetClass, ticker: t.ticker, name: t.name, sigma });
      } catch {
        noSample++;
      }
    }
    console.log(`  측정 성공 ${measured.filter((m) => m.assetClass === assetClass).length}종목`);
  }

  // ── 분포 ────────────────────────────────────────────────────
  const sorted = measured.map((m) => m.sigma).sort((a, b) => a - b);
  console.log(`\n=== 전체 σ 분포 (n=${sorted.length}, 표본 부족·조회 실패 ${noSample}, 레버리지 제외 ${leverageSkipped}) ===`);
  for (const q of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    console.log(`  p${String(Math.round(q * 100)).padStart(2)}: ${(quantile(sorted, q) * 100).toFixed(2)}%`);
  }

  for (const ac of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    const s = measured.filter((m) => m.assetClass === ac).map((m) => m.sigma).sort((a, b) => a - b);
    if (s.length === 0) continue;
    console.log(
      `  [${ac}] n=${s.length} 중앙값 ${(quantile(s, 0.5) * 100).toFixed(2)}% / p10 ${(quantile(s, 0.1) * 100).toFixed(2)}% / p90 ${(quantile(s, 0.9) * 100).toFixed(2)}%`,
    );
  }

  // ── 제안 경계 = 5분위 ────────────────────────────────────────
  const proposed = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(sorted, q));
  const rounded = proposed.map((v) => Number((Math.round(v * 2000) / 2000).toFixed(4))); // 0.05%p 격자
  console.log(`\n=== 제안 경계 (5분위, 0.05%p 반올림) ===`);
  console.log(`  현재: ${STABILITY_SIGMA_BOUNDS.map((b) => (b * 100).toFixed(2) + '%').join(' / ')}`);
  console.log(`  제안: ${rounded.map((b) => (b * 100).toFixed(2) + '%').join(' / ')}`);

  const dist = (bounds: readonly number[]) => {
    const counts = [0, 0, 0, 0, 0];
    for (const m of measured) counts[levelWith(bounds, m.sigma) - 1]++;
    return counts.map((c) => `★${counts.indexOf(c) + 1}`).length
      ? counts.map((c, i) => `★${i + 1}:${((c / measured.length) * 100).toFixed(0)}%`).join(' ')
      : '';
  };
  console.log(`  현재 점유율: ${dist(STABILITY_SIGMA_BOUNDS)}`);
  console.log(`  제안 점유율: ${dist(rounded)}`);

  // ── 앵커가 어디에 떨어지나 ───────────────────────────────────
  console.log(`\n=== 익숙한 이름들 ===`);
  for (const [, ticker] of ANCHORS) {
    const m = measured.find((x) => x.ticker === ticker);
    if (!m) {
      console.log(`  ${ticker}: 측정 실패`);
      continue;
    }
    console.log(
      `  ${m.name.padEnd(8)} σ=${(m.sigma * 100).toFixed(2)}%  현재 ★${levelWith(STABILITY_SIGMA_BOUNDS, m.sigma)} → 제안 ★${levelWith(rounded, m.sigma)}`,
    );
  }

  // 가장 조용한/거친 종목 — 눈금 양 끝이 무엇인지 보여준다
  const byS = [...measured].sort((a, b) => a.sigma - b.sigma);
  console.log(`\n  가장 조용: ${byS.slice(0, 5).map((m) => `${m.name}(${(m.sigma * 100).toFixed(1)}%)`).join(' ')}`);
  console.log(`  가장 거침: ${byS.slice(-5).map((m) => `${m.name}(${(m.sigma * 100).toFixed(1)}%)`).join(' ')}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
