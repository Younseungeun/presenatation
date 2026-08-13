import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { isLeveragedProduct } from '../src/domain/leveragedProduct';
import { isNonEquityProduct } from '../src/domain/nonEquityProduct';
import { resolveProvider, toMarketDateString } from '../src/domain/marketData';
import { realizedDailySigma } from '../src/domain/stability';
import {
  computeReachScore,
  maxMagnitudePct,
  minMagnitudePct,
  noSkillTouchProbability,
} from '../src/domain/scoring';
import { createDefaultRegistry } from '../src/infra/marketData/registry';

// σ 추정기 캘리브레이션 — npm run calibrate:sigma
//
// ── 무엇을 묻나 ───────────────────────────────────────────────
// p₀는 **카드 기간 동안의** 변동성을 알아야 계산할 수 있는데, 가진 것은 과거뿐이다.
// σ가 과소평가되면 두 곳이 동시에 헐거워진다 — p₀가 낮아지고(적중 보상 부풀림),
// 같은 σ를 쓰는 크기 하한도 낮아진다.
//
// ── 잣대 (2026-08-13 2차 — 외부 검토 반영) ────────────────────
// 1차에서는 "과소평가 비율"을 봤다. 그것은 **얼마나 자주** 틀리는지만 말할 뿐
// **얼마나 이득인지**를 말하지 않는다. 그래서 두 축으로 바꾼다:
//
//   ① 불로 점수 — 실력 없는 사람이 σ 오차만으로 얻는 기대 점수.
//      진짜 도달 확률은 σ_실제로, 채점은 σ_추정으로 이뤄질 때
//      (크기·신뢰도를 **악용자가 최적화**한 값으로) 기대 점수가 양수면 그게 불로득이다.
//      σ가 정확하면 이 값은 반드시 0이다(적정 점수법) — 0에서 얼마나 벌어지는지를 잰다.
//
//   ② 차단율 — σ 과대평가로 크기 하한이 부당하게 올라가 정상 카드가 막히는 비율.
//      하한 ∝ σ이므로 σ_추정/σ_실제가 곧 하한의 부풀림 배수다.
//
// 두 축은 상충한다(보수적일수록 ①↓ ②↑). 그래서 표를 파레토 곡선으로 읽는다.
//
// ── 기한을 나눠 본다 ──────────────────────────────────────────
// 1차는 forward 30거래일 하나만 봤다. 장기 카드에 단기 창을 쓰는 것이 옳은지는
// 그것으로 답할 수 없다 — 변동성은 장기적으로 평균 회귀하기 때문이다.
// forward 30 / 60 / 120거래일을 따로 잰다. (KIS 일봉이 한 번에 300건이라
// 120 + 120 = 240을 넘기면 원점이 거의 남지 않아 180일 이상은 재지 못한다)

const HORIZONS = [30, 60, 120] as const;
const LONG = 120;
const SHORT = 20;
const PARK = 10;
const EWMA_LAMBDA = 0.94;
const STRIDE = 10;

const SAMPLE: Record<AssetClass, number> = {
  KR_EQUITY: 40,
  US_EQUITY: 40,
  CRYPTO: 20,
};

/** 지수가중 변동성 (RiskMetrics λ=0.94) */
function ewmaSigma(returns: readonly number[], lambda = EWMA_LAMBDA): number | null {
  if (returns.length < SHORT) return null;
  const head = returns.slice(0, Math.floor(returns.length / 2));
  let v = head.reduce((a, r) => a + r * r, 0) / Math.max(1, head.length);
  for (const r of returns) v = lambda * v + (1 - lambda) * r * r;
  return Math.sqrt(v);
}

/**
 * Parkinson 변동성 — 고가/저가의 로그 폭으로 잰다.
 *   σ_P = sqrt( mean( ln(H/L)² ) / (4 ln2) )
 * 종가가 제자리여도 장중이 벌어지면 먼저 반응한다 — "폭풍 전 고요"를 종가 σ보다
 * 이르게 잡는다. 고가·저가는 이미 받고 있는 일봉에 들어 있어 호출이 늘지 않는다.
 */
function parkinsonSigma(
  highs: readonly number[],
  lows: readonly number[],
  volumes: readonly number[],
): number | null {
  const terms: number[] = [];
  for (let i = 0; i < highs.length; i++) {
    if (volumes[i] !== undefined && volumes[i] <= 0) continue;
    const h = highs[i];
    const l = lows[i];
    if (!Number.isFinite(h) || !Number.isFinite(l) || h <= 0 || l <= 0 || h < l) continue;
    terms.push(Math.log(h / l) ** 2);
  }
  if (terms.length < 5) return null;
  return Math.sqrt(terms.reduce((a, b) => a + b, 0) / terms.length / (4 * Math.LN2));
}

function logReturns(closes: readonly number[], volumes: readonly number[]): number[] {
  const usable = closes
    .map((c, i) => ({ c, v: volumes[i] }))
    .filter((p) => Number.isFinite(p.c) && p.c > 0 && (p.v === undefined || p.v > 0))
    .map((p) => p.c);
  const out: number[] = [];
  for (let i = 1; i < usable.length; i++) out.push(Math.log(usable[i] / usable[i - 1]));
  return out;
}

/**
 * 실력 없는 사람이 σ 오차만으로 얻는 최대 기대 점수 (크기·신뢰도를 악용자가 최적화).
 * σ가 정확하면 0 (적정 점수법의 −D(p₀‖p̂) ≤ 0).
 */
function exploitScore(
  assetClass: AssetClass,
  sigmaEst: number,
  sigmaTrue: number,
  horizonDays: number,
): number {
  const floor = minMagnitudePct(assetClass, sigmaEst, horizonDays);
  const cap = maxMagnitudePct(assetClass, horizonDays, sigmaEst);
  let best = 0;
  const step = Math.max(0.5, (cap - floor) / 18);
  for (let M = floor; M <= cap; M += step) {
    // 채점은 추정 σ로, 실제 결과는 진짜 σ로 일어난다
    const p0True = noSkillTouchProbability('UP', M, assetClass, horizonDays, sigmaTrue);
    for (let c = 2; c <= 10; c++) {
      const hit = computeReachScore('UP', M, c, assetClass, horizonDays, true, sigmaEst).score;
      const miss = computeReachScore('UP', M, c, assetClass, horizonDays, false, sigmaEst).score;
      const ev = p0True * hit + (1 - p0True) * miss;
      if (ev > best) best = ev;
    }
  }
  return best;
}

interface Row {
  assetClass: AssetClass;
  horizon: number;
  est: Record<string, number>;
  trueSigma: number;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const registry = createDefaultRegistry();
  const rows: Row[] = [];

  const to = toMarketDateString(new Date(), 'KR_EQUITY');
  const from = toMarketDateString(new Date(Date.now() - 460 * 86_400_000), 'KR_EQUITY');
  const maxH = Math.max(...HORIZONS);

  for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    const pool = await prisma.instrument.findMany({
      where: { assetClass, active: true },
      select: { ticker: true, name: true },
      take: 600,
    });
    const usable = pool.filter(
      (i) => !isLeveragedProduct(i.name, i.ticker) && !isNonEquityProduct(i.name, i.ticker),
    );
    const picked = usable
      .map((i, idx) => ({ i, k: (idx * 2654435761) % 1_000_003 }))
      .sort((a, b) => a.k - b.k)
      .slice(0, SAMPLE[assetClass])
      .map((x) => x.i);

    const provider = resolveProvider(registry, assetClass);
    let done = 0;
    for (const inst of picked) {
      try {
        const q = await provider.getDailyQuotes(inst.ticker, from, to);
        const closes = q.map((x) => x.close);
        const highs = q.map((x) => x.high);
        const lows = q.map((x) => x.low);
        const vols = q.map((x) => x.volume ?? 1);

        for (let t = LONG + 1; t + maxH < closes.length; t += STRIDE) {
          const pc = closes.slice(0, t);
          const pv = vols.slice(0, t);
          const l120 = realizedDailySigma(pc.slice(-(LONG + 1)), pv.slice(-(LONG + 1)));
          const s20 = realizedDailySigma(pc.slice(-(SHORT + 1)), pv.slice(-(SHORT + 1)));
          const ew = ewmaSigma(logReturns(pc.slice(-(LONG + 1)), pv.slice(-(LONG + 1))));
          const park = parkinsonSigma(
            highs.slice(t - PARK, t),
            lows.slice(t - PARK, t),
            vols.slice(t - PARK, t),
          );
          if (l120 === null || s20 === null || ew === null || park === null) continue;

          const est: Record<string, number> = {
            'L120 (현행)': l120,
            'MAX(20,120)': Math.max(s20, l120),
            'MAX(120,P10)': Math.max(l120, park),
            'MAX(20,120,P10)': Math.max(s20, l120, park),
            EWMA: ew,
            '조화(20,120)': (2 * s20 * l120) / (s20 + l120),
          };

          for (const H of HORIZONS) {
            const fwd = realizedDailySigma(
              closes.slice(t, t + H + 1),
              vols.slice(t, t + H + 1),
            );
            if (fwd === null || fwd <= 0) continue;
            rows.push({ assetClass, horizon: H, est, trueSigma: fwd });
          }
        }
      } catch {
        /* 결측·상장 초기는 표본에서 빠진다 */
      }
      done++;
      if (done % 10 === 0) console.log(`  ${assetClass} ${done}/${picked.length} …`);
    }
  }
  await prisma.$disconnect();

  if (rows.length === 0) {
    console.log('표본이 비었다 — 시세 조회 실패 여부 확인');
    return;
  }

  const NAMES = Object.keys(rows[0].est);
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };

  function report(label: string, subset: Row[]): void {
    if (subset.length < 20) return;
    console.log(`\n─── ${label}  (관측 ${subset.length.toLocaleString()}개) ───`);
    console.log(
      `  ${'추정기'.padEnd(17)}${'불로점수'.padStart(10)}${'>0 비율'.padStart(9)}` +
        `${'차단 1.2x'.padStart(11)}${'차단 1.5x'.padStart(11)}${'중앙비율'.padStart(10)}`,
    );
    for (const n of NAMES) {
      let exploitSum = 0;
      let positives = 0;
      let b12 = 0;
      let b15 = 0;
      const ratios: number[] = [];
      for (const r of subset) {
        const e = exploitScore(r.assetClass, r.est[n], r.trueSigma, r.horizon);
        exploitSum += e;
        if (e > 0.5) positives++;
        const ratio = r.est[n] / r.trueSigma;
        ratios.push(ratio);
        if (ratio > 1.2) b12++;
        if (ratio > 1.5) b15++;
      }
      const k = subset.length;
      console.log(
        `  ${n.padEnd(17)}${(exploitSum / k).toFixed(1).padStart(10)}` +
          `${((positives / k) * 100).toFixed(1).padStart(8)}%` +
          `${((b12 / k) * 100).toFixed(1).padStart(10)}%${((b15 / k) * 100).toFixed(1).padStart(10)}%` +
          `${median(ratios).toFixed(3).padStart(10)}`,
      );
    }
  }

  console.log('\n  불로점수 = 실력 없는 사람이 σ 오차만으로 얻는 카드당 기대 점수 (0이 이상)');
  console.log('  차단 1.2x = 크기 하한이 정당한 값의 1.2배를 넘는 비율 (정상 카드가 막힌다)');

  for (const H of HORIZONS) report(`기한 ${H}거래일 · 전체`, rows.filter((r) => r.horizon === H));
  for (const a of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    report(`${a} · 기한 30거래일`, rows.filter((r) => r.assetClass === a && r.horizon === 30));
  }
  const quiet = [...rows.filter((r) => r.horizon === 30)].sort(
    (a, b) => a.est['L120 (현행)'] - b.est['L120 (현행)'],
  );
  report('가장 조용한 20% · 기한 30거래일', quiet.slice(0, Math.floor(quiet.length * 0.2)));
}

void main();
