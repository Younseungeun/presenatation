import { DAILY_SIGMA, noSkillTouchProbability } from '../src/domain/scoring';

// 신뢰도 칸 수 검증 — npx tsx scripts/simConfidenceLevels.ts
//
// ══ 앞선 비교의 결함 ═══════════════════════════════════════════
// simScoreModel.ts는 후보를 (칸 수 × 사다리 모양)으로 묶어 비교했는데, 그러면
// **두 축이 섞인다**: 기하 7칸(×2)의 꼭대기는 2⁶=64배, 기하 10칸(×1.6)은 1.6⁹=69배,
// 선형 5칸은 5배다. 칸 수가 달라진 건지 **사다리가 닿는 범위**가 달라진 건지 알 수 없다.
//
// 게다가 이론은 반대를 말한다: 적정 점수법에서 신고 해상도가 높을수록 진짜 확률에
// 가깝게 신고할 수 있으므로 **칸이 많을수록 (약)우월**해야 한다. 시뮬이 7칸 > 10칸을
// 냈다면 잡음이거나 격자 정렬 때문일 가능성이 크다.
//
// ══ 그래서 축을 하나씩 움직인다 ════════════════════════════════
//   ① 범위를 고정하고 칸 수만: multiple(c) = T^((c−1)/(L−1)) — 어느 L이든 1배~T배를 덮는다
//   ② 칸 수를 고정하고 범위 T만
//   ③ 연속 신고(칸 수 → ∞)를 천장으로 두고, 이산화가 얼마를 잃는지 잰다
//   ④ 씨앗을 여러 개 돌려 잡음 폭을 함께 낸다 — 0.01 차이로 결론을 내지 않기 위해

const ASSET = 'KR_EQUITY' as const;
const SIGMA = DAILY_SIGMA[ASSET];
const H = 30;
const CARDS = 20;
const N = 8_000;
const SEEDS = [20260813, 777, 31337, 90210, 424242];

const COHORTS = [
  { name: '정밀', k: 0.5, weight: 0.05 },
  { name: '우수', k: 0.35, weight: 0.25 },
  { name: '준수', k: 0.2, weight: 0.5 },
  { name: '하위', k: 0.08, weight: 0.15 },
  { name: '스팸', k: 0, weight: 0.05 },
] as const;

let seed = 0;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function ncdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t) +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function touchProb(mPct: number, k: number): number {
  const a = Math.log(1 + mPct / 100) + 0.5826 * SIGMA;
  const nu = k * SIGMA - 0.5 * SIGMA * SIGMA;
  const s = SIGMA * Math.sqrt(H);
  const p =
    1 -
    ncdf((a - nu * H) / s) +
    Math.exp((2 * nu * a) / (SIGMA * SIGMA)) * (1 - ncdf((a + nu * H) / s));
  return Math.min(0.999, Math.max(0.0005, p));
}

const p0Cache = new Map<number, number>();
function p0Of(m: number): number {
  let v = p0Cache.get(m);
  if (v === undefined) {
    v = noSkillTouchProbability('UP', m, ASSET, H, SIGMA);
    p0Cache.set(m, v);
  }
  return v;
}

const odds = (p: number) => p / (1 - p);
const fromOdds = (o: number) => o / (1 + o);
const P_HAT_CAP = 0.97;
const claimed = (p0: number, mult: number) => Math.min(P_HAT_CAP, fromOdds(odds(p0) * mult));
const info = (p0: number, pHat: number, hit: boolean) =>
  hit ? Math.log(pHat / p0) : Math.log((1 - pHat) / (1 - p0));

const SCALE = 100;
const M_GRID = Array.from({ length: 16 }, (_, i) => 5 + i * 2.5);
const sizeWeight = (mPct: number) => {
  const lv = 1 + [1.5, 2, 3, 5].filter((b) => mPct / 5 >= b).length;
  return 1 + 0.25 * (lv - 1);
};

/**
 * 칸 수 L, 꼭대기 배수 T의 기하 사다리. L=Infinity면 연속(진짜 확률을 그대로 신고).
 * 어느 L이든 1배~T배의 같은 범위를 덮으므로 **해상도만 달라진다**.
 */
function multipleFor(c: number, L: number, T: number): number {
  return L <= 1 ? 1 : Math.pow(T, (c - 1) / (L - 1));
}

interface Strategy {
  M: number;
  p: number;
  p0: number;
  pHat: number;
  w: number;
}
function bestStrategy(k: number, L: number, T: number): Strategy {
  let best: Strategy | null = null;
  let bestEv = -Infinity;
  for (const M of M_GRID) {
    const p0 = p0Of(M);
    const p = touchProb(M, k);
    const w = sizeWeight(M);
    // 연속 신고: 적정 점수법이라 진짜 확률이 최적. 다만 사다리 범위 [1, T]는 지킨다
    const cands: number[] =
      L === Infinity
        ? [Math.min(claimed(p0, T), Math.max(p0, p))]
        : Array.from({ length: L }, (_, i) => claimed(p0, multipleFor(i + 1, L, T)));
    for (const pHat of cands) {
      const ev = SCALE * w * (p * info(p0, pHat, true) + (1 - p) * info(p0, pHat, false));
      if (ev > bestEv) {
        bestEv = ev;
        best = { M, p, p0, pHat, w };
      }
    }
  }
  return best!;
}

function auc(low: number[], high: number[]): number {
  const a = [...low].sort((x, y) => x - y);
  let wins = 0;
  for (const h of high) {
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < h) lo = mid + 1;
      else hi = mid;
    }
    let eq = 0;
    for (let j = lo; j < a.length && a[j] === h; j++) eq++;
    wins += lo + eq / 2;
  }
  return wins / (low.length * high.length);
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

interface Run {
  aucLow: number;
  aucSpam: number;
  rho: number;
  tailGap: number;
}
function runOnce(L: number, T: number, s: number): Run {
  seed = s;
  const strat = COHORTS.map((c) => bestStrategy(c.k, L, T));
  const groups: number[][] = [[], [], [], [], []];
  const people: Array<{ ci: number; score: number }> = [];
  for (let i = 0; i < N; i++) {
    let r = rand();
    let ci = 0;
    for (; ci < COHORTS.length - 1; ci++) {
      if (r < COHORTS[ci].weight) break;
      r -= COHORTS[ci].weight;
    }
    const st = strat[ci];
    let score = 0;
    for (let t = 0; t < CARDS; t++) {
      score += SCALE * st.w * info(st.p0, st.pHat, rand() < st.p);
    }
    groups[ci].push(score);
    people.push({ ci, score });
  }
  const byScore = [...people].sort((a, b) => a.score - b.score);
  const rank = new Map<(typeof people)[number], number>();
  byScore.forEach((p, i) => rank.set(p, i + 1));
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const sk = people.map((p) => 4 - p.ci);
  const rk = people.map((p) => rank.get(p)!);
  const ms = mean(sk);
  const mr = mean(rk);
  let num = 0;
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < people.length; i++) {
    const a = sk[i] - ms;
    const b = rk[i] - mr;
    num += a * b;
    d1 += a * a;
    d2 += b * b;
  }
  const mid = [...groups[2]].sort((a, b) => a - b);
  const spam = [...groups[4]].sort((a, b) => a - b);
  return {
    aucLow: auc(groups[3], groups[2]),
    aucSpam: auc(groups[4], groups[2]),
    rho: num / Math.sqrt(d1 * d2),
    tailGap: quantile(mid, 0.05) - quantile(spam, 0.95),
  };
}

function repeat(L: number, T: number): { m: Run; sd: number } {
  const runs = SEEDS.map((s) => runOnce(L, T, s));
  const avg = (f: (r: Run) => number) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  const m: Run = {
    aucLow: avg((r) => r.aucLow),
    aucSpam: avg((r) => r.aucSpam),
    rho: avg((r) => r.rho),
    tailGap: avg((r) => r.tailGap),
  };
  const sd = Math.sqrt(avg((r) => (r.aucLow - m.aucLow) ** 2));
  return { m, sd };
}

// ══════════════════════════════════════════════════════════════
console.log(`\n■ ① 범위를 고정(꼭대기 64배)하고 **칸 수만** 바꾼다  — 씨앗 ${SEEDS.length}개 평균\n`);
console.log(
  `  ${'칸 수'.padStart(6)}${'AUC하위'.padStart(10)}${'±잡음'.padStart(8)}${'AUC스팸'.padStart(10)}${'순위상관'.padStart(10)}${'꼬리간격'.padStart(10)}`,
);
for (const L of [3, 4, 5, 6, 7, 8, 10, 12, 15, 20, Infinity]) {
  const { m, sd } = repeat(L, 64);
  const label = L === Infinity ? '연속' : String(L);
  console.log(
    `  ${label.padStart(6)}${m.aucLow.toFixed(4).padStart(10)}${sd.toFixed(4).padStart(8)}` +
      `${m.aucSpam.toFixed(4).padStart(10)}${m.rho.toFixed(4).padStart(10)}${m.tailGap.toFixed(0).padStart(10)}`,
  );
}

console.log(`\n\n■ ② 칸 수를 고정(7칸)하고 **꼭대기 배수만** 바꾼다\n`);
console.log(
  `  ${'꼭대기'.padStart(8)}${'AUC하위'.padStart(10)}${'±잡음'.padStart(8)}${'AUC스팸'.padStart(10)}${'순위상관'.padStart(10)}${'꼬리간격'.padStart(10)}`,
);
for (const T of [4, 8, 16, 32, 64, 128, 256, 1024]) {
  const { m, sd } = repeat(7, T);
  console.log(
    `  ${`×${T}`.padStart(8)}${m.aucLow.toFixed(4).padStart(10)}${sd.toFixed(4).padStart(8)}` +
      `${m.aucSpam.toFixed(4).padStart(10)}${m.rho.toFixed(4).padStart(10)}${m.tailGap.toFixed(0).padStart(10)}`,
  );
}

console.log(`\n\n■ ③ 칸 수 × 범위 격자 (AUC 하위<준수)\n`);
const LS = [5, 7, 10, 15];
const TS = [8, 16, 32, 64, 128, 256];
console.log(`  ${'칸\\꼭대기'.padEnd(10)}${TS.map((t) => `×${t}`.padStart(9)).join('')}`);
for (const L of LS) {
  const cells = TS.map((T) => repeat(L, T).m.aucLow.toFixed(4).padStart(9)).join('');
  console.log(`  ${String(L).padEnd(10)}${cells}`);
}

console.log(`\n\n■ ④ 각 실력이 실제로 쓰는 칸 (꼭대기 ×64)\n`);
for (const L of [5, 7, 10]) {
  const cells = COHORTS.map((co) => {
    const st = bestStrategy(co.k, L, 64);
    // 어느 칸을 골랐는지 역산
    let c = 1;
    let bestD = Infinity;
    for (let i = 1; i <= L; i++) {
      const d = Math.abs(claimed(st.p0, multipleFor(i, L, 64)) - st.pHat);
      if (d < bestD) {
        bestD = d;
        c = i;
      }
    }
    return `${co.name} c${c}/${L}(p̂${(st.pHat * 100).toFixed(0)}%)`;
  });
  console.log(`  ${String(L).padStart(2)}칸: ${cells.join('  ')}`);
}

console.log(`\n  참고 — 각 실력의 진짜 도달 확률 (M은 각자 최적)`);
for (const co of COHORTS) {
  const st = bestStrategy(co.k, 7, 64);
  console.log(
    `    ${co.name}: M=${st.M}% p₀=${(st.p0 * 100).toFixed(1)}% 진짜 p=${(st.p * 100).toFixed(1)}% (승산 ${(odds(st.p) / odds(st.p0)).toFixed(1)}배)`,
  );
}
console.log('');

// ══════════════════════════════════════════════════════════════
// ⑤ **AUC는 칸 수를 정하는 기준이 될 수 없다** (위 ①~③이 보인 것).
//
// 값이 잡음(±0.002)의 수십 배로 튀고, 무엇보다 **연속 신고가 7칸보다 낮게** 나온다.
// 적정 점수법에서 해상도가 높을수록 나빠질 수는 없으므로 이건 격자 정렬의 우연이다.
// 더 나쁜 것은, AUC를 최대화하면 **일부러 부정확한 신고를 강요하는 쪽**으로 밀린다는
// 점이다 — 격자가 어떤 실력을 과소 신고하게 만들면 그 사람의 분산이 줄어 AUC가 오른다.
// 우리가 원하는 것은 그 반대다.
//
// 칸 수의 진짜 기준은 **신고 해상도**다: 각자 자기 진짜 승산을 얼마나 정확히
// 신고할 수 있는가. 적정 점수법의 목적에 직접 대응하고, 격자 우연을 타지 않는다.
console.log('\n\n■ ⑤ 신고 해상도 — 진짜 승산을 얼마나 정확히 신고할 수 있나\n');
console.log('  (오차 = |ln(신고 배수) − ln(진짜 배수)|, 코호트 평균. 낮을수록 좋다)\n');
console.log(`  ${'칸\꼭대기'.padEnd(10)}${[16, 64, 140, 256].map((t) => `×${t}`.padStart(10)).join('')}`);
for (const L of [5, 7, 10, 15, 20]) {
  const cells = [16, 64, 140, 256].map((T) => {
    let sum = 0;
    for (const co of COHORTS) {
      const st = bestStrategy(co.k, L, T);
      const trueMult = odds(st.p) / odds(st.p0);
      // 사다리에서 진짜 배수에 가장 가까운 칸
      let bestErr = Infinity;
      for (let c = 1; c <= L; c++) {
        bestErr = Math.min(bestErr, Math.abs(Math.log(multipleFor(c, L, T)) - Math.log(trueMult)));
      }
      sum += bestErr;
    }
    return (sum / COHORTS.length).toFixed(3).padStart(10);
  });
  console.log(`  ${String(L).padEnd(10)}${cells}`);
}

console.log('\n  실제 필요한 범위 — 각 실력의 진짜 승산 배수:');
for (const co of COHORTS) {
  const st = bestStrategy(co.k, 10, 140);
  console.log(`    ${co.name}: ×${(odds(st.p) / odds(st.p0)).toFixed(1)}`);
}
console.log('\n  → 꼭대기가 이 최대값을 못 덮으면 상위 실력자는 자기 우위를 신고할 수 없다');
console.log('  → 같은 범위에서 칸이 많을수록 오차가 단조 감소한다 (이론과 일치)');
console.log('');
