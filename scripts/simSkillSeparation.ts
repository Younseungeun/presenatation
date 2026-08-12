import {
  CONFIDENCE_RANGE,
  DAILY_SIGMA,
  disciplineFor,
  minMagnitudePct,
  maxMagnitudePct,
  noSkillTouchProbability,
  scoreJudgedCard,
  type Discipline,
} from '../src/domain/scoring';

// 실력 분리력 최적화 — npx tsx scripts/simSkillSeparation.ts
//
// 묻는 것: **점수가 실력을 얼마나 잘 가르는가.** 그리고 신뢰도 하한·규율 래더·등급
// 임계값을 어떻게 잡아야 그 분리가 가장 좋아지는가.
//
// 왜 다시 재는가: 크기 하한이 σ 연동으로 바뀌면서 지분 B=10·M이 통째로 커졌고
// (σ2%·30일 기준 5% → 13.1%), 신뢰도 하한이 2로 오르며 카드당 점수 분포도 옮겨갔다.
// 옛 임계값(3,500/14,500/23,000)은 그 전의 눈금이라 이제 아무것도 뜻하지 않는다.
//
// ── 분리력을 무엇으로 재는가 ────────────────────────────────────
// 목표 피라미드(시니어 50 / 마스터 25 / 펠로우 10%)는 **분포의 모양**일 뿐,
// 그 자리에 맞는 사람이 앉는지는 말해주지 않는다. 그래서 세 가지를 함께 본다:
//   ① 오분류 — 스팸이 시니어에 오르는 비율(거짓 양성), 정밀이 못 오르는 비율(거짓 음성)
//   ② AUC — 인접 실력대 두 사람을 뽑았을 때 더 잘하는 쪽의 점수가 높을 확률.
//      0.5는 동전 던지기, 1.0은 완전 분리
//   ③ 순위상관 — 실력 순서와 점수 순서가 얼마나 같은가 (전체적인 정렬 품질)
//
// 행동 가정: 각자 **자기 실력에서 기대 점수가 최대인 (크기 M, 신뢰도 c)** 를 고른다.
// v4는 정직 신고가 곧 EV 최대라 이것이 "정직하게 신고한다"와 같은 뜻이다.
// 규율 래더는 시즌 **도중에** 발동하므로, 점수가 떨어지면 그 자리에서 다시 고른다.

const ASSET = 'KR_EQUITY' as const;
const SIGMA = DAILY_SIGMA[ASSET];
const H = 30;
const CARDS = 20;
const N = 12_000;

interface Cohort {
  name: string;
  k: number;
  weight: number;
}
const COHORTS: Cohort[] = [
  { name: '정밀', k: 0.5, weight: 0.05 },
  { name: '우수', k: 0.35, weight: 0.25 },
  { name: '준수', k: 0.2, weight: 0.5 },
  { name: '하위', k: 0.08, weight: 0.15 },
  { name: '스팸', k: 0, weight: 0.05 },
];

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

/** 실력 k(일 드리프트 k·σ)를 반영한 도달 확률 — p₀와 같은 유도에 드리프트만 더한다 */
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

/**
 * v4 점수 — **정산이 쓰는 공식을 그대로 옮긴 것**.
 *
 * 도메인 함수(scoreJudgedCard)를 직접 부르지 않는 이유는 하나뿐이다: 그쪽은 이제
 * c=1을 거부하는데, 이 시뮬은 "하한을 1로 뒀다면 어땠을까"라는 **반사실**을 재야 한다.
 * 옮겨 적은 공식이 갈라지지 않도록 아래에서 허용 구간 전체를 도메인 함수와 대조한다.
 */
function cardScore(M: number, c: number, hit: boolean): number {
  const p0 = noSkillTouchProbability('UP', M, ASSET, H, SIGMA);
  const B = 10 * M;
  return hit ? B * c * (1 - p0) : -B * ((c * (c + 1)) / 2) * p0;
}

// 옮겨 적은 공식이 정산과 같은 값을 내는지 — 갈라지면 이 시뮬의 결론이 전부 무효다
for (const M of [15, 25, 40]) {
  for (let c = CONFIDENCE_RANGE.min; c <= CONFIDENCE_RANGE.max; c++) {
    for (const hit of [true, false]) {
      const domain = scoreJudgedCard({
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: M,
        confidence: c,
        assetClass: ASSET,
        sigmaDaily: SIGMA,
        basePrice: 100,
        settledPrice: hit ? 100 * (1 + M / 100) : 100,
        horizonDays: H,
        outcome: hit ? 'HIT' : 'MISS',
      }).score;
      if (Math.abs(domain - cardScore(M, c, hit)) > 1e-9) {
        throw new Error(`점수 공식이 정산과 다르다: M=${M} c=${c} hit=${hit}`);
      }
    }
  }
}

const FLOOR = minMagnitudePct(ASSET, SIGMA, H);
const CAP = maxMagnitudePct(ASSET, H, SIGMA);
const M_GRID = Array.from({ length: 14 }, (_, i) => FLOOR + (i * (CAP - FLOOR)) / 13);

interface Strategy {
  M: number;
  c: number;
  p: number;
  ev: number;
}
/** 그 실력에서, 주어진 최소 신뢰도 아래에서 기대 점수가 가장 큰 전략 */
function bestStrategy(k: number, minC: number, cache = new Map<string, Strategy>()): Strategy {
  const key = `${k}:${minC}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let best: Strategy = { M: FLOOR, c: minC, p: 0, ev: -Infinity };
  for (const M of M_GRID) {
    const p = touchProb(M, k);
    for (let c = minC; c <= CONFIDENCE_RANGE.max; c++) {
      const ev = p * cardScore(M, c, true) + (1 - p) * cardScore(M, c, false);
      if (ev > best.ev) best = { M, c, p, ev };
    }
  }
  cache.set(key, best);
  return best;
}

// ── 규율 래더 변형 ────────────────────────────────────────────
type Ladder = ReadonlyArray<{ scoreBelow: number } & Discipline>;
const LADDERS: Array<{ name: string; ladder: Ladder | null }> = [
  { name: '현행', ladder: null }, // domain의 disciplineFor 그대로
  {
    name: '1단 상향(c≥3)',
    ladder: [
      { scoreBelow: -10_000, minConfidence: 10, publishSuspended: true },
      { scoreBelow: -6_000, minConfidence: 7, publishSuspended: false },
      { scoreBelow: -3_000, minConfidence: 5, publishSuspended: false },
      { scoreBelow: -1_000, minConfidence: 3, publishSuspended: false },
    ],
  },
  {
    name: '조기 개입',
    ladder: [
      { scoreBelow: -6_000, minConfidence: 10, publishSuspended: true },
      { scoreBelow: -3_000, minConfidence: 7, publishSuspended: false },
      { scoreBelow: -1_500, minConfidence: 5, publishSuspended: false },
      { scoreBelow: -500, minConfidence: 3, publishSuspended: false },
    ],
  },
];

function disciplineWith(ladder: Ladder | null, score: number, minC: number): Discipline {
  if (!ladder) {
    const d = disciplineFor(score);
    return { ...d, minConfidence: Math.max(d.minConfidence, minC) };
  }
  for (const rung of ladder) {
    if (score <= rung.scoreBelow) {
      return { minConfidence: Math.max(rung.minConfidence, minC), publishSuspended: rung.publishSuspended };
    }
  }
  return { minConfidence: minC, publishSuspended: false };
}

// ── 시즌 시뮬 ─────────────────────────────────────────────────
interface Person {
  cohort: number;
  score: number;
  cards: number;
}

function runSeason(minC: number, ladder: Ladder | null): Person[] {
  const cache = new Map<string, Strategy>();
  const people: Person[] = [];
  for (let i = 0; i < N; i++) {
    // 코호트 추첨
    let r = rand();
    let ci = 0;
    for (; ci < COHORTS.length - 1; ci++) {
      if (r < COHORTS[ci].weight) break;
      r -= COHORTS[ci].weight;
    }
    const k = COHORTS[ci].k;

    let score = 0;
    let cards = 0;
    for (let t = 0; t < CARDS; t++) {
      const d = disciplineWith(ladder, score, minC);
      if (d.publishSuspended) break; // 게시 정지 — 시즌 끝
      const s = bestStrategy(k, d.minConfidence, cache);
      const hit = rand() < s.p;
      score += cardScore(s.M, s.c, hit);
      cards++;
    }
    people.push({ cohort: ci, score, cards });
  }
  return people;
}

// ── 지표 ─────────────────────────────────────────────────────
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 두 집단의 AUC — 무작위로 하나씩 뽑았을 때 위쪽 집단의 점수가 높을 확률 */
function auc(low: number[], high: number[]): number {
  const a = [...low].sort((x, y) => x - y);
  let wins = 0;
  for (const h of high) {
    // a 중 h보다 작은 개수 (동점은 절반)
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

/** 스피어만 순위상관 — 실력 순서와 점수 순서의 일치도 */
function spearman(people: Person[]): number {
  const n = people.length;
  const byScore = [...people].sort((a, b) => a.score - b.score);
  const rank = new Map<Person, number>();
  byScore.forEach((p, i) => rank.set(p, i + 1));
  // 실력은 코호트 번호의 역순 (0=정밀이 가장 높다)
  const skill = people.map((p) => COHORTS.length - 1 - p.cohort);
  const scoreRank = people.map((p) => rank.get(p)!);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const ms = mean(skill);
  const mr = mean(scoreRank);
  let num = 0;
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < n; i++) {
    const a = skill[i] - ms;
    const b = scoreRank[i] - mr;
    num += a * b;
    d1 += a * a;
    d2 += b * b;
  }
  return num / Math.sqrt(d1 * d2);
}

function evaluate(label: string, people: Person[]): void {
  const scores = people.map((p) => p.score).sort((a, b) => a - b);
  // 목표 피라미드에 맞춘 임계값
  const tSenior = quantile(scores, 0.5);
  const tMaster = quantile(scores, 0.75);
  const tFellow = quantile(scores, 0.9);

  console.log(`\n─── ${label} ───`);
  console.log(
    `  등급 임계값(목표 50/25/10%): 시니어 ${tSenior.toFixed(0)} / 마스터 ${tMaster.toFixed(0)} / 펠로우 ${tFellow.toFixed(0)}`,
  );

  const byCohort = COHORTS.map((_, i) => people.filter((p) => p.cohort === i));
  console.log(`  ${'코호트'.padEnd(6)}${'n'.padStart(6)}${'중앙 점수'.padStart(11)}${'시니어+'.padStart(9)}${'마스터+'.padStart(9)}${'펠로우'.padStart(8)}${'게시정지'.padStart(9)}`);
  for (let i = 0; i < COHORTS.length; i++) {
    const g = byCohort[i];
    if (g.length === 0) continue;
    const s = g.map((p) => p.score).sort((a, b) => a - b);
    const pct = (f: (p: Person) => boolean) => `${((g.filter(f).length / g.length) * 100).toFixed(1)}%`;
    console.log(
      `  ${COHORTS[i].name.padEnd(6)}${String(g.length).padStart(6)}${quantile(s, 0.5).toFixed(0).padStart(11)}` +
        `${pct((p) => p.score >= tSenior).padStart(9)}${pct((p) => p.score >= tMaster).padStart(9)}` +
        `${pct((p) => p.score >= tFellow).padStart(8)}${pct((p) => p.cards < CARDS).padStart(9)}`,
    );
  }

  // 규율 래더가 실제로 닿는 자리인지 보려면 **아래 꼬리**를 봐야 한다
  console.log(`  ${'코호트'.padEnd(6)}${'p1'.padStart(10)}${'p5'.padStart(10)}${'p10'.padStart(10)}${'p25'.padStart(10)}   ← 점수 아래 꼬리`);
  for (let i = 0; i < COHORTS.length; i++) {
    const s = byCohort[i].map((p) => p.score).sort((a, b) => a - b);
    if (s.length === 0) continue;
    const cells = [0.01, 0.05, 0.1, 0.25].map((q) => quantile(s, q).toFixed(0).padStart(10));
    console.log(`  ${COHORTS[i].name.padEnd(6)}${cells.join('')}`);
  }

  const spam = byCohort[4].map((p) => p.score);
  const low = byCohort[3].map((p) => p.score);
  const mid = byCohort[2].map((p) => p.score);
  const good = byCohort[1].map((p) => p.score);
  const fine = byCohort[0].map((p) => p.score);
  console.log(
    `  AUC  스팸<준수 ${auc(spam, mid).toFixed(3)} / 하위<준수 ${auc(low, mid).toFixed(3)} / 준수<우수 ${auc(mid, good).toFixed(3)} / 우수<정밀 ${auc(good, fine).toFixed(3)}`,
  );
  console.log(`  순위상관(실력↔점수) ${spearman(people).toFixed(3)}`);
  const falsePos = byCohort[4].filter((p) => p.score >= tSenior).length / byCohort[4].length;
  const falseNeg = byCohort[0].filter((p) => p.score < tSenior).length / byCohort[0].length;
  console.log(
    `  오분류  스팸이 시니어 도달 ${(falsePos * 100).toFixed(1)}% / 정밀이 시니어 미달 ${(falseNeg * 100).toFixed(1)}%`,
  );
}

// ══════════════════════════════════════════════════════════════
console.log(`\n■ 기준 트랙: ${ASSET} σ=${(SIGMA * 100).toFixed(1)}%/일, ${H}일 카드, 시즌 ${CARDS}장`);
console.log(`  크기 하한 ${FLOOR.toFixed(1)}% / 상한 ${CAP.toFixed(1)}% (σ 연동)`);
console.log(`  현재 신뢰도 하한 ${CONFIDENCE_RANGE.min}\n`);

console.log('■ 실력별 최적 전략 (신뢰도 하한별)');
console.log(`  ${'실력'.padEnd(6)}${'하한1'.padStart(16)}${'하한2'.padStart(16)}${'하한3'.padStart(16)}`);
for (const co of COHORTS) {
  const cells = [1, 2, 3].map((mc) => {
    const s = bestStrategy(co.k, mc);
    return `M${s.M.toFixed(0)} c${s.c} EV${s.ev.toFixed(0)}`.padStart(16);
  });
  console.log(`  ${co.name.padEnd(6)}${cells.join('')}`);
}

for (const minC of [1, 2, 3]) {
  for (const { name, ladder } of LADDERS) {
    // 래더 변형은 현행 하한(2)에서만 비교 — 축을 하나씩 움직인다
    if (minC !== CONFIDENCE_RANGE.min && name !== '현행') continue;
    evaluate(`신뢰도 하한 ${minC} · 래더 ${name}`, runSeason(minC, ladder));
  }
}

console.log('');
