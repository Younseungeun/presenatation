import {
  CONFIDENCE_RANGE,
  DAILY_SIGMA,
  DISCIPLINE_LADDER,
  claimedProbability,
  magnitudeWeight,
  maxMagnitudePct,
  minMagnitudePct,
  noSkillTouchProbability,
  SCORE_SCALE,
  scoreJudgedCard,
} from '../src/domain/scoring';

// 규율 래더 재설계 (점수 v5) — npx tsx scripts/simDisciplineLadder.ts
//
// ── 왜 다시 짜는가 ────────────────────────────────────────────
// 래더 자체는 v3 이후 한 줄도 바뀌지 않았다. 바뀐 것은 그 밑의 점수 눈금이다.
// 그래서 세 가지를 함께 물어야 한다:
//   ① 무엇을 재서 발동할 것인가 (누적 점수 vs 카드당 평균)
//   ② 무엇을 제약할 것인가 (최소 신뢰도 ↑ vs 최대 신뢰도 ↓)
//   ③ 문턱은 어디인가
//
// ── 표적을 모집단에 넣는다 ─────────────────────────────────────
// simSkillSeparation의 코호트는 전부 **기대 점수를 최대화**한다. v5는 적정 점수법이라
// 그것이 곧 정직한 신고다. 즉 그 모집단에는 **래더가 잡아야 할 사람이 없다** —
// 다들 정직하니 점수가 깊이 음수로 갈 이유가 없고, 어떤 문턱을 재도 "발동 안 함"만 나온다.
//
// 실제 표적은 **거짓 신고자**다. 동기는 점수가 아니라 판매다: 신뢰도는 별점으로 노출되는
// 구매 신호라, 실력 없이 c를 크게 불러도 **팔린다.** 점수를 잃는 것은 그들에게 비용이 아니다.
// 그래서 EV를 최적화하지 않는 코호트를 넣는다 — 이들이 래더의 존재 이유다.

const ASSET = 'KR_EQUITY' as const;
const SIGMA = DAILY_SIGMA[ASSET];
const H = 30;
const CARDS = 20;
const N = 12_000;

type Behavior =
  | { kind: 'EV' } // 기대 점수 최대 = 정직 신고
  | { kind: 'CLAIM'; c: number }; // 실력과 무관하게 c를 고정으로 부른다

interface Cohort {
  name: string;
  k: number;
  weight: number;
  behavior: Behavior;
  /** 래더가 잡아야 하는 대상인가 — 오작동/적중을 가르는 정답 라벨 */
  target: boolean;
}

// 정직 코호트의 비중은 simSkillSeparation과 같게 두고, 거짓 신고자를 그 위에 얹는다
// (비중 6%는 짐작이다 — 절대 수치가 아니라 코호트별 발동률을 보려는 것이다).
const COHORTS: Cohort[] = [
  { name: '정밀', k: 0.5, weight: 0.05, behavior: { kind: 'EV' }, target: false },
  { name: '우수', k: 0.35, weight: 0.24, behavior: { kind: 'EV' }, target: false },
  { name: '준수', k: 0.2, weight: 0.47, behavior: { kind: 'EV' }, target: false },
  { name: '하위', k: 0.08, weight: 0.14, behavior: { kind: 'EV' }, target: false },
  { name: '스팸', k: 0, weight: 0.04, behavior: { kind: 'EV' }, target: false },
  // ── 표적: 실력 없이 확신만 크게 부르는 사람들 ──
  { name: '과장c6', k: 0.08, weight: 0.02, behavior: { kind: 'CLAIM', c: 6 }, target: true },
  { name: '과장c8', k: 0.05, weight: 0.02, behavior: { kind: 'CLAIM', c: 8 }, target: true },
  { name: '허위c10', k: 0, weight: 0.02, behavior: { kind: 'CLAIM', c: 10 }, target: true },
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

/** 카드 한 장의 **정보량** — 가중·배수를 걷어낸 로그우도비 기여분 */
function cardInfo(M: number, c: number, hit: boolean): number {
  const p0 = noSkillTouchProbability('UP', M, ASSET, H, SIGMA);
  const pHat = claimedProbability(p0, c);
  return hit ? Math.log(pHat / p0) : Math.log((1 - pHat) / (1 - p0));
}

function cardScore(M: number, c: number, hit: boolean): number {
  return SCORE_SCALE * magnitudeWeight(ASSET, M) * cardInfo(M, c, hit);
}

// 옮겨 적은 공식이 정산과 갈라지면 이 시뮬의 결론은 전부 무효다
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

const evCache = new Map<string, { M: number; c: number; p: number; ev: number }>();
/** 그 실력에서 신뢰도 상한 아래 기대 점수가 최대인 (크기, 신뢰도) */
function bestStrategy(k: number, capC: number) {
  const key = `${k}:${capC}`;
  const memo = evCache.get(key);
  if (memo) return memo;
  let best = { M: FLOOR, c: CONFIDENCE_RANGE.min, p: 0, ev: -Infinity };
  for (const M of M_GRID) {
    const p = touchProb(M, k);
    for (let c = CONFIDENCE_RANGE.min; c <= capC; c++) {
      const ev = p * cardScore(M, c, true) + (1 - p) * cardScore(M, c, false);
      if (ev > best.ev) best = { M, c, p, ev };
    }
  }
  evCache.set(key, best);
  return best;
}

/** 거짓 신고자의 크기 선택 — 점수가 아니라 **팔림새**를 좇는다(수익성 구간 상위) */
const CLAIM_M = M_GRID[Math.floor(M_GRID.length * 0.6)];

// ══════════════════════════════════════════════════════════════
// 규율 래더 후보
// ══════════════════════════════════════════════════════════════
type Metric = 'TOTAL' | 'MEAN' | 'UCB' | 'LLR';
type Instrument = 'MIN_C' | 'MAX_C';
interface Rung {
  /** 이 값 이하면 발동 (TOTAL이면 누적 점수, MEAN이면 카드당 평균) */
  below: number;
  /** MIN_C면 최소 신뢰도, MAX_C면 최대 신뢰도 */
  c: number;
  suspend: boolean;
}
interface Ladder {
  name: string;
  metric: Metric;
  instrument: Instrument;
  /** 이 장수 미만이면 발동하지 않는다 */
  minSample: number;
  rungs: Rung[];
  /** UCB일 때 표준오차 배수 (1.64 = 95% 단측, 2.33 = 99%) */
  z?: number;
}

const LADDERS: Ladder[] = [
  {
    name: '현행 (누적·최소신뢰도)',
    metric: 'TOTAL',
    instrument: 'MIN_C',
    minSample: 0,
    rungs: [
      { below: -10_000, c: 10, suspend: true },
      { below: -6_000, c: 7, suspend: false },
      { below: -3_000, c: 5, suspend: false },
      { below: -1_000, c: 2, suspend: false },
    ],
  },
  {
    name: '누적·신뢰도 상한',
    metric: 'TOTAL',
    instrument: 'MAX_C',
    minSample: 0,
    rungs: [
      { below: -6_000, c: 2, suspend: true },
      { below: -3_000, c: 3, suspend: false },
      { below: -1_500, c: 5, suspend: false },
      { below: -600, c: 7, suspend: false },
    ],
  },
  {
    name: '평균·신뢰도 상한 (느슨)',
    metric: 'MEAN',
    instrument: 'MAX_C',
    minSample: 5,
    rungs: [
      { below: -300, c: 2, suspend: true },
      { below: -200, c: 3, suspend: false },
      { below: -120, c: 5, suspend: false },
      { below: -60, c: 7, suspend: false },
    ],
  },
  {
    name: '평균·신뢰도 상한 (표준)',
    metric: 'MEAN',
    instrument: 'MAX_C',
    minSample: 4,
    rungs: [
      { below: -250, c: 2, suspend: true },
      { below: -150, c: 3, suspend: false },
      { below: -80, c: 5, suspend: false },
      { below: -30, c: 7, suspend: false },
    ],
  },
  {
    name: '평균·신뢰도 상한 (조기)',
    metric: 'MEAN',
    instrument: 'MAX_C',
    minSample: 3,
    rungs: [
      { below: -200, c: 2, suspend: true },
      { below: -110, c: 3, suspend: false },
      { below: -55, c: 5, suspend: false },
      { below: -20, c: 7, suspend: false },
    ],
  },
  // ── 신뢰구간 상한 = 불운과 거짓말을 가르는 축 ──
  // 표본이 적으면 구간이 넓어 발동하지 않고, 쌓일수록 좁아져 구조적인 것만 남는다.
  { name: 'UCB z=1.64 (95%)', metric: 'UCB', instrument: 'MAX_C', minSample: 3, z: 1.64, rungs: [
    { below: -200, c: 2, suspend: true },
    { below: -110, c: 3, suspend: false },
    { below: -55, c: 5, suspend: false },
    { below: -15, c: 7, suspend: false },
  ] },
  { name: 'UCB z=2.33 (99%)', metric: 'UCB', instrument: 'MAX_C', minSample: 3, z: 2.33, rungs: [
    { below: -200, c: 2, suspend: true },
    { below: -110, c: 3, suspend: false },
    { below: -55, c: 5, suspend: false },
    { below: -15, c: 7, suspend: false },
  ] },
  { name: 'UCB z=2.33 · 문턱 0 기준', metric: 'UCB', instrument: 'MAX_C', minSample: 3, z: 2.33, rungs: [
    { below: -150, c: 2, suspend: true },
    { below: -80, c: 3, suspend: false },
    { below: -30, c: 5, suspend: false },
    { below: 0, c: 7, suspend: false },
  ] },
  { name: 'UCB z=3.0 · 문턱 0 기준', metric: 'UCB', instrument: 'MAX_C', minSample: 3, z: 3.0, rungs: [
    { below: -150, c: 2, suspend: true },
    { below: -80, c: 3, suspend: false },
    { below: -30, c: 5, suspend: false },
    { below: 0, c: 7, suspend: false },
  ] },
  // ── 순차 검정 (SPRT / Ville 부등식) ──────────────────────────
  // v5 점수는 이미 로그우도비다: 카드의 정보량 합 D = ln( L(신고 모델) / L(무정보) ).
  // 신고가 정직하면 1/Λ는 평균 1의 비음 마팅게일이므로 Ville 부등식이 곧바로 온다:
  //     P( 시즌 중 언젠가 D ≤ −ln(1/α) )  ≤  α
  // **표본 수와 무관하게** 성립한다 — 최소 표본도, 정지 규칙 보정도 필요 없다.
  // 문턱이 곧 오작동 상한이라, 숫자를 시뮬레이션으로 고르는 것이 아니라 **고르고 검증한다.**
  { name: 'SPRT (α 5/1/0.1/0.01%)', metric: 'LLR', instrument: 'MAX_C', minSample: 0, rungs: [
    { below: -Math.log(1 / 0.0001), c: 2, suspend: true }, // −9.21
    { below: -Math.log(1 / 0.001), c: 3, suspend: false }, // −6.91
    { below: -Math.log(1 / 0.01), c: 5, suspend: false }, // −4.61
    { below: -Math.log(1 / 0.05), c: 7, suspend: false }, // −3.00
  ] },
  { name: 'SPRT 보수 (α 1/0.1/0.01/0.001%)', metric: 'LLR', instrument: 'MAX_C', minSample: 0, rungs: [
    { below: -Math.log(1 / 0.00001), c: 2, suspend: true }, // −11.51
    { below: -Math.log(1 / 0.0001), c: 3, suspend: false }, // −9.21
    { below: -Math.log(1 / 0.001), c: 5, suspend: false }, // −6.91
    { below: -Math.log(1 / 0.01), c: 7, suspend: false }, // −4.61
  ] },
  // **채택안 = 도메인의 래더 그대로.** 값을 여기 옮겨 적지 않는다 — 옮겨 적는 순간
  // 시뮬과 정산이 갈라질 수 있고, 그러면 이 표는 아무것도 증명하지 못한다.
  {
    name: '채택 (domain/scoring.DISCIPLINE_LADDER)',
    metric: 'LLR',
    instrument: 'MAX_C',
    minSample: 0,
    rungs: DISCIPLINE_LADDER.map((r) => ({
      below: r.evidenceBelow,
      c: r.maxConfidence,
      suspend: r.publishSuspended,
    })),
  },
  { name: 'SPRT 보수 · 최소신뢰도(대조군)', metric: 'LLR', instrument: 'MIN_C', minSample: 0, rungs: [
    { below: -Math.log(1 / 0.00001), c: 10, suspend: true },
    { below: -Math.log(1 / 0.0001), c: 7, suspend: false },
    { below: -Math.log(1 / 0.001), c: 5, suspend: false },
    { below: -Math.log(1 / 0.01), c: 3, suspend: false },
  ] },
];

interface Applied {
  capC: number;
  minC: number;
  suspend: boolean;
  /** 몇 단이 발동했는가 (0 = 없음) */
  rung: number;
}
/**
 * @param total 누적 점수
 * @param cards 판정된 카드 수
 * @param sumSq 카드 점수 제곱합 — 표본 표준편차를 내는 데 쓴다 (UCB)
 */
function apply(l: Ladder, total: number, cards: number, sumSq: number): Applied {
  const free: Applied = {
    capC: CONFIDENCE_RANGE.max,
    minC: CONFIDENCE_RANGE.min,
    suspend: false,
    rung: 0,
  };
  if (cards < l.minSample) return free;
  let v: number;
  if (l.metric === 'TOTAL') {
    v = total;
  } else if (l.metric === 'LLR') {
    // total에 **가중치 없는 정보량의 합**이 들어온다 — 아래 runSeason 참조
    v = total;
  } else {
    const mean = cards > 0 ? total / cards : 0;
    if (l.metric === 'MEAN') {
      v = mean;
    } else {
      // 평균의 **신뢰구간 상한**: 표본이 적으면 넓어 발동하지 않고, 쌓이면 좁아진다.
      // "이 사람의 진짜 카드당 정보량이 아직 이보다 높을 수 있는가"를 묻는 값이다.
      const varSample = cards > 1 ? Math.max(0, (sumSq - cards * mean * mean) / (cards - 1)) : 0;
      const se = Math.sqrt(varSample / cards);
      v = mean + (l.z ?? 1.64) * se;
    }
  }
  for (let i = 0; i < l.rungs.length; i++) {
    const r = l.rungs[i];
    if (v <= r.below) {
      const rung = l.rungs.length - i; // 배열은 깊은 단부터
      return l.instrument === 'MAX_C'
        ? { capC: Math.max(CONFIDENCE_RANGE.min, r.c), minC: CONFIDENCE_RANGE.min, suspend: r.suspend, rung }
        : { capC: CONFIDENCE_RANGE.max, minC: r.c, suspend: r.suspend, rung };
    }
  }
  return free;
}

// ── 시즌 ─────────────────────────────────────────────────────
interface Person {
  cohort: number;
  score: number;
  cards: number;
  /** 발동 시점의 카드 번호 (한 번도 안 걸리면 −1) */
  firedAt: number;
  /** 시즌 중 닿은 가장 깊은 단 (0 = 없음) */
  deepest: number;
  /** 구매자에게 ★4 이상(c≥7)으로 팔린 카드 수 — 실력 없는 사람의 것만 해악으로 센다 */
  loudCards: number;
  suspended: boolean;
}

function runSeason(l: Ladder): Person[] {
  const people: Person[] = [];
  for (let i = 0; i < N; i++) {
    let r = rand();
    let ci = 0;
    for (; ci < COHORTS.length - 1; ci++) {
      if (r < COHORTS[ci].weight) break;
      r -= COHORTS[ci].weight;
    }
    const co = COHORTS[ci];

    let score = 0;
    let llr = 0;
    let sumSq = 0;
    let cards = 0;
    let firedAt = -1;
    let deepest = 0;
    let loud = 0;
    let suspended = false;

    for (let t = 0; t < CARDS; t++) {
      const d = apply(l, l.metric === 'LLR' ? llr : score, cards, sumSq);
      if (d.rung > deepest) deepest = d.rung;
      if (d.suspend) {
        suspended = true;
        if (firedAt < 0) firedAt = t;
        break;
      }
      if (d.rung > 0 && firedAt < 0) firedAt = t;

      let M: number;
      let c: number;
      if (co.behavior.kind === 'EV') {
        const s = bestStrategy(co.k, d.capC);
        M = s.M;
        c = Math.max(d.minC, s.c);
      } else {
        M = CLAIM_M;
        c = Math.min(d.capC, Math.max(d.minC, co.behavior.c));
      }
      const p = touchProb(M, co.k);
      const hit = rand() < p;
      const s = cardScore(M, c, hit);
      score += s;
      llr += cardInfo(M, c, hit);
      sumSq += s * s;
      cards++;
      if (c >= 7 && co.k < 0.2) loud++;
    }
    people.push({ cohort: ci, score, cards, firedAt, deepest, loudCards: loud, suspended });
  }
  return people;
}

// ── 출력 ─────────────────────────────────────────────────────
function evaluate(l: Ladder): void {
  const people = runSeason(l);
  console.log(`\n─── ${l.name} ───`);
  if (l.metric === 'MEAN') console.log(`  지표: 카드당 평균 · 최소 표본 ${l.minSample}장`);
  console.log(
    `  ${'코호트'.padEnd(8)}${'n'.padStart(6)}${'발동'.padStart(8)}${'2단+'.padStart(7)}${'3단+'.padStart(7)}` +
      `${'정지'.padStart(7)}${'발동 시점'.padStart(10)}${'★4+ 카드'.padStart(10)}`,
  );
  let harm = 0;
  let falseFire = 0;
  let falseDeep = 0;
  let falseN = 0;
  let hitFire = 0;
  let targetN = 0;
  for (let i = 0; i < COHORTS.length; i++) {
    const g = people.filter((p) => p.cohort === i);
    if (g.length === 0) continue;
    const fired = g.filter((p) => p.firedAt >= 0);
    const at = fired.length ? fired.reduce((a, p) => a + p.firedAt, 0) / fired.length : NaN;
    const loud = g.reduce((a, p) => a + p.loudCards, 0) / g.length;
    harm += g.reduce((a, p) => a + p.loudCards, 0);
    const deep = (n: number) => g.filter((p) => p.deepest >= n).length / g.length;
    if (COHORTS[i].target) {
      hitFire += fired.length;
      targetN += g.length;
    } else {
      falseFire += fired.length;
      falseDeep += g.filter((p) => p.deepest >= 2).length;
      falseN += g.length;
    }
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    console.log(
      `  ${COHORTS[i].name.padEnd(8)}${String(g.length).padStart(6)}` +
        `${pct(fired.length / g.length).padStart(8)}${pct(deep(2)).padStart(7)}${pct(deep(3)).padStart(7)}` +
        `${pct(g.filter((p) => p.suspended).length / g.length).padStart(7)}` +
        `${(Number.isNaN(at) ? '—' : at.toFixed(1) + '장').padStart(10)}` +
        `${loud.toFixed(1).padStart(10)}`,
    );
  }
  console.log(
    `  ▸ 표적 발동 ${((hitFire / targetN) * 100).toFixed(1)}% · ` +
      `오작동 ${((falseFire / falseN) * 100).toFixed(2)}% (2단+ ${((falseDeep / falseN) * 100).toFixed(2)}%) · ` +
      `실력 없이 ★4+로 팔린 카드 ${(harm / people.length).toFixed(2)}장/인`,
  );
}

console.log(`\n■ ${ASSET} σ=${(SIGMA * 100).toFixed(1)}%/일 · ${H}일 카드 · 시즌 ${CARDS}장 · n=${N}`);
console.log(`  크기 ${FLOOR.toFixed(1)}~${CAP.toFixed(1)}% · 신뢰도 ${CONFIDENCE_RANGE.min}~${CONFIDENCE_RANGE.max}\n`);

console.log('■ 코호트별 카드당 기대 점수 (제약 없을 때)');
console.log(`  ${'코호트'.padEnd(8)}${'행동'.padStart(10)}${'EV/카드'.padStart(10)}${'시즌 20장'.padStart(11)}`);
for (const co of COHORTS) {
  let ev: number;
  let label: string;
  if (co.behavior.kind === 'EV') {
    const s = bestStrategy(co.k, CONFIDENCE_RANGE.max);
    ev = s.ev;
    label = `정직 c${s.c}`;
  } else {
    const p = touchProb(CLAIM_M, co.k);
    ev = p * cardScore(CLAIM_M, co.behavior.c, true) + (1 - p) * cardScore(CLAIM_M, co.behavior.c, false);
    label = `과장 c${co.behavior.c}`;
  }
  console.log(
    `  ${co.name.padEnd(8)}${label.padStart(10)}${ev.toFixed(1).padStart(10)}${(ev * CARDS).toFixed(0).padStart(11)}`,
  );
}

console.log('\n■ 규율 없이 두면');
evaluate({ name: '규율 없음', metric: 'MEAN', instrument: 'MAX_C', minSample: 999, rungs: [] });

for (const l of LADDERS) evaluate(l);

console.log('');
