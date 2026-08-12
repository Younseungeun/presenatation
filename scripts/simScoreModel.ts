import { DAILY_SIGMA, noSkillTouchProbability } from '../src/domain/scoring';

// 점수 모델 원점 재설계 — npx tsx scripts/simScoreModel.ts
//
// ══ 왜 다시 세우는가 ═══════════════════════════════════════════
// v4(공정배당 이항)의 실측 결함 (scripts/simSkillSeparation.ts):
//   · 카드 한 장의 점수가 배팅 크기 B=10·M과 벌점 증폭 c(c+1)/2에 비례해 **분산이 폭발**한다.
//     c=10이면 실패 한 번이 −55·B — 준수형의 시즌 점수 하위 1%가 −5,528까지 내려간다
//   · 그래서 "점수가 낮다"가 "실력이 없다"를 뜻하지 않는다. **크게 거는 사람이 꼬리도 깊다.**
//     스팸의 최악은 −189인데 준수형의 10%가 −1,180 아래다 — 규율 래더가 실력자만 벌한다
//
// ══ 원리로 돌아가면 ════════════════════════════════════════════
// 카드는 **확률 예보**다. 리서처가 신고하는 것은 두 가지다:
//   ① 무엇을 (방향·크기·기한) → 무정보 도달 확률 p₀가 정해진다
//   ② 얼마나 확신하는가 (신뢰도) → 자기가 믿는 확률 p̂를 신고하는 것과 같다
//
// 그러면 점수는 "이 예보가 **무정보 대비 정보를 얼마나 더했는가**"여야 한다.
// 그 양은 통계학이 이미 답을 갖고 있다 — **기준 대비 로그 점수**:
//
//     적중:  I = ln( p̂ / p₀ )
//     실패:  I = ln( (1−p̂) / (1−p₀) )
//
// 성질 (모두 이 시뮬이 수치로 확인한다):
//  · **적정(proper)**: 기대 정보량 = p·ln(p̂/p₀) + (1−p)·ln((1−p̂)/(1−p₀)) 는 p̂ = p에서 최대.
//    정직 신고가 유일한 최적이다
//  · **무실력자의 기대 정보량 = −D(p₀ ‖ p̂) ≤ 0**, 등호는 p̂ = p₀(=신뢰도 최저)일 때뿐.
//    **확신을 신고하는 순간 음수가 된다** — v4처럼 "신뢰도 1 은신처"를 따로 막을 필요가 없다
//  · **실력자의 기대 정보량 = D(p ‖ p₀) > 0** — 쿨백-라이블러 발산, 즉 그 사람이 시장에
//    더한 정보량 그 자체다. 시즌 점수는 그 총합이 된다
//  · **카드당 점수가 유계다.** p₀와 p̂를 안전 구간에 두면 한 장이 낼 수 있는 최대·최소가
//    닫혀 있어 분산이 폭발하지 않는다 — v4가 무너진 바로 그 자리다
//  · **배팅 크기에 비례하지 않는다.** 큰 목표는 p₀가 작아 적중 시 로그비가 저절로 커진다 —
//    난이도가 이미 정보량에 들어 있어 크기를 따로 곱할 필요가 없다
//
// ══ 이 시뮬이 정하는 것 ════════════════════════════════════════
//  ① 신뢰도 사다리의 모양 (선형 승산배수 vs 기하 승산배수)
//  ② 신뢰도 구간 수 (5 / 7 / 10)
//  ③ 수익성(크기)을 점수에 곱할 것인가, 곱한다면 얼마나
//  ④ 점수 스케일과 등급 임계값
// 판정 기준은 **실력 분리력**이다 — AUC·순위상관·오분류·꼬리 교차.

const ASSET = 'KR_EQUITY' as const;
const SIGMA = DAILY_SIGMA[ASSET];
const H = 30;
const CARDS = 20;
const N = 12_000;

/** 실력 = 일 로그 드리프트 k·σ (기존 캘리브레이션과 같은 모집단 모델) */
const COHORTS = [
  { name: '정밀', k: 0.5, weight: 0.05 },
  { name: '우수', k: 0.35, weight: 0.25 },
  { name: '준수', k: 0.2, weight: 0.5 },
  { name: '하위', k: 0.08, weight: 0.15 },
  { name: '스팸', k: 0, weight: 0.05 },
] as const;

// ── 난수 ─────────────────────────────────────────────────────
let seed = 20260813;
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

/** 실력 k를 반영한 실제 도달 확률 */
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

const p0Of = (mPct: number) => noSkillTouchProbability('UP', mPct, ASSET, H, SIGMA);

// ── 모델 정의 ────────────────────────────────────────────────
const odds = (p: number) => p / (1 - p);
const fromOdds = (o: number) => o / (1 + o);

/** 신뢰도 사다리: c번째 칸의 **승산 배수** */
type Ladder = { name: string; levels: number; multiple: (c: number) => number };
const LADDERS: Ladder[] = [
  { name: '선형 10칸', levels: 10, multiple: (c) => c },
  { name: '선형 5칸', levels: 5, multiple: (c) => c },
  { name: '선형 7칸', levels: 7, multiple: (c) => c },
  { name: '기하 10칸(×1.6)', levels: 10, multiple: (c) => Math.pow(1.6, c - 1) },
  { name: '기하 7칸(×2)', levels: 7, multiple: (c) => Math.pow(2, c - 1) },
  { name: '기하 5칸(×2.5)', levels: 5, multiple: (c) => Math.pow(2.5, c - 1) },
];

/** 신고 확률 p̂ — 승산을 배수만큼 증폭한다 (신뢰도 = "내 승산이 무정보의 몇 배인가") */
function claimed(p0: number, mult: number): number {
  return Math.min(0.97, fromOdds(odds(p0) * mult));
}

/** 카드 정보량 — 기준(p₀) 대비 로그 점수 */
function info(p0: number, pHat: number, hit: boolean): number {
  return hit ? Math.log(pHat / p0) : Math.log((1 - pHat) / (1 - p0));
}

/** 수익성 5구간 — 크기가 자산군 기준 단위 F의 몇 배인가 (지금 쓰는 경계와 같은 모양) */
const PROFIT_BOUNDS = [1.5, 2, 3, 5];
function profitLevel(mPct: number, unit = 5): number {
  const mult = mPct / unit;
  return 1 + PROFIT_BOUNDS.filter((b) => mult >= b).length;
}

/** 수익성 가중 후보 — 정보량에 곱한다 */
type SizeWeight = { name: string; w: (level: number) => number };
const SIZE_WEIGHTS: SizeWeight[] = [
  { name: '없음', w: () => 1 },
  { name: '완만(1~2)', w: (lv) => 1 + 0.25 * (lv - 1) },
  { name: '보통(1~3)', w: (lv) => 1 + 0.5 * (lv - 1) },
  { name: '구간번호(1~5)', w: (lv) => lv },
];

const SCALE = 100; // 사람이 읽는 점수로 옮기는 배수 (분리력에는 영향 없음)

// ── 행동: 각자 자기 실력에서 기대 점수가 최대인 (M, c) ─────────
const M_GRID = Array.from({ length: 16 }, (_, i) => 5 + i * 2.5); // 5% ~ 42.5%

interface Strategy {
  M: number;
  c: number;
  p: number;
  p0: number;
  pHat: number;
  ev: number;
}
function bestStrategy(k: number, ladder: Ladder, sw: SizeWeight): Strategy {
  let best: Strategy | null = null;
  for (const M of M_GRID) {
    const p0 = p0Of(M);
    const p = touchProb(M, k);
    const w = sw.w(profitLevel(M));
    for (let c = 1; c <= ladder.levels; c++) {
      const pHat = claimed(p0, ladder.multiple(c));
      const ev =
        SCALE * w * (p * info(p0, pHat, true) + (1 - p) * info(p0, pHat, false));
      if (!best || ev > best.ev) best = { M, c, p, p0, pHat, ev };
    }
  }
  return best!;
}

// ── 지표 ─────────────────────────────────────────────────────
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
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

interface Person {
  cohort: number;
  score: number;
}

function runSeason(ladder: Ladder, sw: SizeWeight, cards = CARDS): Person[] {
  const strat = COHORTS.map((co) => bestStrategy(co.k, ladder, sw));
  const people: Person[] = [];
  for (let i = 0; i < N; i++) {
    let r = rand();
    let ci = 0;
    for (; ci < COHORTS.length - 1; ci++) {
      if (r < COHORTS[ci].weight) break;
      r -= COHORTS[ci].weight;
    }
    const s = strat[ci];
    const w = sw.w(profitLevel(s.M));
    let score = 0;
    for (let t = 0; t < cards; t++) {
      const hit = rand() < s.p;
      score += SCALE * w * info(s.p0, s.pHat, hit);
    }
    people.push({ cohort: ci, score });
  }
  return people;
}

interface Result {
  label: string;
  aucSpam: number;
  aucLow: number;
  aucMid: number;
  aucHigh: number;
  rho: number;
  falsePos: number;
  falseNeg: number;
  tailGap: number;
  thresholds: [number, number, number];
}

function evaluate(label: string, people: Person[]): Result {
  const all = people.map((p) => p.score).sort((a, b) => a - b);
  const t: [number, number, number] = [
    quantile(all, 0.5),
    quantile(all, 0.75),
    quantile(all, 0.9),
  ];
  const g = COHORTS.map((_, i) => people.filter((p) => p.cohort === i).map((p) => p.score));
  const spam = g[4];
  const low = g[3];
  const mid = g[2];
  const good = g[1];
  const fine = g[0];

  // 순위상관 (실력 등급 vs 점수)
  const byScore = [...people].sort((a, b) => a.score - b.score);
  const rank = new Map<Person, number>();
  byScore.forEach((p, i) => rank.set(p, i + 1));
  const skill = people.map((p) => 4 - p.cohort);
  const sr = people.map((p) => rank.get(p)!);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const ms = mean(skill);
  const mr = mean(sr);
  let num = 0;
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < people.length; i++) {
    const a = skill[i] - ms;
    const b = sr[i] - mr;
    num += a * b;
    d1 += a * a;
    d2 += b * b;
  }

  const midSorted = [...mid].sort((a, b) => a - b);
  const spamSorted = [...spam].sort((a, b) => a - b);

  return {
    label,
    aucSpam: auc(spam, mid),
    aucLow: auc(low, mid),
    aucMid: auc(mid, good),
    aucHigh: auc(good, fine),
    rho: num / Math.sqrt(d1 * d2),
    falsePos: spam.filter((s) => s >= t[0]).length / spam.length,
    falseNeg: fine.filter((s) => s < t[0]).length / fine.length,
    // 꼬리 교차: 준수형 하위 5%가 스팸 상위 5%보다 낮으면 음수 (겹친다)
    tailGap: quantile(midSorted, 0.05) - quantile(spamSorted, 0.95),
    thresholds: t,
  };
}

// ══════════════════════════════════════════════════════════════
console.log('\n■ 적정성 확인 — 정직 신고가 최적인가 (기대 정보량이 p̂ = p에서 최대)\n');
{
  const M = 20;
  const p0 = p0Of(M);
  console.log(`  M=${M}% p₀=${(p0 * 100).toFixed(1)}%`);
  for (const k of [0, 0.2, 0.5]) {
    const p = touchProb(M, k);
    let bestHat = 0;
    let bestEv = -Infinity;
    for (let h = 0.01; h < 0.97; h += 0.005) {
      const ev = p * info(p0, h, true) + (1 - p) * info(p0, h, false);
      if (ev > bestEv) {
        bestEv = ev;
        bestHat = h;
      }
    }
    console.log(
      `  실력 k=${k}: 진짜 p=${(p * 100).toFixed(1)}% → 최적 신고 p̂=${(bestHat * 100).toFixed(1)}%  (기대 정보량 ${bestEv.toFixed(4)})`,
    );
  }
  const p = touchProb(M, 0);
  console.log(`\n  무실력자가 확신을 부풀리면 (진짜 p=${(p * 100).toFixed(1)}%):`);
  for (const mult of [1, 2, 4, 10]) {
    const hat = claimed(p0, mult);
    const ev = p * info(p0, hat, true) + (1 - p) * info(p0, hat, false);
    console.log(`    승산 ${String(mult).padStart(2)}배 신고(p̂=${(hat * 100).toFixed(1)}%) → 기대 정보량 ${ev.toFixed(4)}`);
  }
}

console.log('\n\n■ 설계 후보 비교 (시즌 20장, n=12,000)\n');
console.log(
  `  ${'사다리'.padEnd(16)}${'수익성가중'.padEnd(14)}${'AUC스팸'.padStart(9)}${'AUC하위'.padStart(9)}${'AUC준수'.padStart(9)}${'AUC우수'.padStart(9)}${'순위상관'.padStart(10)}${'꼬리간격'.padStart(10)}`,
);
const results: Result[] = [];
for (const ladder of LADDERS) {
  for (const sw of SIZE_WEIGHTS) {
    const r = evaluate(`${ladder.name} / ${sw.name}`, runSeason(ladder, sw));
    results.push(r);
    console.log(
      `  ${ladder.name.padEnd(16)}${sw.name.padEnd(14)}` +
        `${r.aucSpam.toFixed(3).padStart(9)}${r.aucLow.toFixed(3).padStart(9)}` +
        `${r.aucMid.toFixed(3).padStart(9)}${r.aucHigh.toFixed(3).padStart(9)}` +
        `${r.rho.toFixed(3).padStart(10)}${r.tailGap.toFixed(0).padStart(10)}`,
    );
  }
}

// 종합 순위 — 가장 약한 고리(하위<준수)를 우선하고 순위상관을 함께 본다
const ranked = [...results].sort((a, b) => b.aucLow + b.rho - (a.aucLow + a.rho));
console.log('\n  ── 종합 상위 5 (하위<준수 AUC + 순위상관) ──');
for (const r of ranked.slice(0, 5)) {
  console.log(
    `    ${r.label.padEnd(32)} AUC하위 ${r.aucLow.toFixed(3)}  순위상관 ${r.rho.toFixed(3)}  꼬리간격 ${r.tailGap.toFixed(0)}`,
  );
}

console.log('\n\n■ v4 대비 — 표본이 쌓일수록 분리가 어떻게 좋아지나 (하위<준수 AUC)\n');
const bestLadder = LADDERS.find((l) => l.name === ranked[0].label.split(' / ')[0])!;
const bestSw = SIZE_WEIGHTS.find((s) => s.name === ranked[0].label.split(' / ')[1])!;
console.log(`  (채택 후보: ${bestLadder.name} / 수익성가중 ${bestSw.name})`);
console.log(`  ${'카드 수'.padStart(8)}${'AUC하위'.padStart(10)}${'AUC스팸'.padStart(10)}${'순위상관'.padStart(10)}`);
for (const n of [5, 10, 20, 40, 80]) {
  const r = evaluate(`n=${n}`, runSeason(bestLadder, bestSw, n));
  console.log(
    `  ${String(n).padStart(8)}${r.aucLow.toFixed(3).padStart(10)}${r.aucSpam.toFixed(3).padStart(10)}${r.rho.toFixed(3).padStart(10)}`,
  );
}

console.log('\n\n■ 채택 후보의 코호트별 결과\n');
{
  const people = runSeason(bestLadder, bestSw);
  const r = evaluate('채택', people);
  console.log(
    `  등급 임계값(50/25/10%): 시니어 ${r.thresholds[0].toFixed(0)} / 마스터 ${r.thresholds[1].toFixed(0)} / 펠로우 ${r.thresholds[2].toFixed(0)}`,
  );
  console.log(`  ${'코호트'.padEnd(6)}${'최적전략'.padStart(16)}${'중앙'.padStart(9)}${'p5'.padStart(9)}${'p95'.padStart(9)}${'시니어+'.padStart(9)}${'마스터+'.padStart(9)}`);
  for (let i = 0; i < COHORTS.length; i++) {
    const s = bestStrategy(COHORTS[i].k, bestLadder, bestSw);
    const g = people.filter((p) => p.cohort === i).map((p) => p.score).sort((a, b) => a - b);
    const pct = (th: number) => `${((g.filter((x) => x >= th).length / g.length) * 100).toFixed(1)}%`;
    console.log(
      `  ${COHORTS[i].name.padEnd(6)}${`M${s.M}% c${s.c}`.padStart(16)}` +
        `${quantile(g, 0.5).toFixed(0).padStart(9)}${quantile(g, 0.05).toFixed(0).padStart(9)}${quantile(g, 0.95).toFixed(0).padStart(9)}` +
        `${pct(r.thresholds[0]).padStart(9)}${pct(r.thresholds[1]).padStart(9)}`,
    );
  }
  console.log(`  오분류: 스팸이 시니어 ${(r.falsePos * 100).toFixed(1)}% / 정밀이 시니어 미달 ${(r.falseNeg * 100).toFixed(1)}%`);
  console.log(`  꼬리 간격(준수 p5 − 스팸 p95): ${r.tailGap.toFixed(0)}  ${r.tailGap > 0 ? '← 겹치지 않는다' : '← 겹친다'}`);
}
console.log('');
