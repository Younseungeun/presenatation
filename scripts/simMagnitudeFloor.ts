import type { AssetClass, Direction } from '../src/domain/constants';
import {
  DAILY_SIGMA,
  PROFITABILITY_BASE_PCT,
  maxMagnitudePct,
  noSkillTouchProbability,
} from '../src/domain/scoring';

// 예측 크기 하한 캘리브레이션 — npm run sim:floor
//
// 묻는 것: 하한을 **종목의 60일 실현 변동성 σ에 비례**시키면 "변동성으로만 hit을 노리는"
// 길이 실제로 닫히는가. 닫힌다면 비례 상수 k는 얼마여야 하는가.
//
// ── 왜 σ·√H 꼴인가 (수학) ────────────────────────────────────────
// 무정보 도달 확률 p₀는 로그 장벽 거리 a를 확산 규모 σ√H로 나눈 **정규화 거리**의 함수다
// (반사원리). 하한을 M = k·σ√H로 두면 그 정규화 거리가 항상 k로 고정되므로
//
//     ∂p₀/∂σ ≈ 0
//
// 즉 **어떤 종목을 고르든 하한 카드의 무정보 적중률이 같아진다.** 이것이
// "변동성으로만 hit을 노릴 수 없다"의 정확한 수학적 진술이다. 고정 %는 이 성질이 없어
// σ가 큰 종목일수록 하한 카드의 p₀가 커진다(= 거친 종목을 고르는 것만으로 이득).
// 잔차는 이산 관측 보정(BGK, +β·σ)과 마팅게일 드리프트(∓σ²/2)에서만 나온다 — 아래 ①이 그 크기를 잰다.
//
// ── k는 무엇을 최대화하는가 ──────────────────────────────────────
// 하한 카드에서 신뢰도 1일 때 기대 점수는 EV = B·(p − p₀), B = 10·M ∝ k.
//   · k가 작으면 → p₀가 1에 가까워 변별력(p−p₀)이 0으로 붕괴 (누구나 맞힌다)
//   · k가 크면  → 지분 B는 크지만 실력자도 못 닿아 (p−p₀)가 0으로 붕괴
// 그래서 f(k) = k·(p−p₀)에 **내부 최적점**이 있다. 그 점이 "실력이 가장 잘 보상되는 하한"이다.

const TRIALS = 40_000;
const K_GRID = [0.4, 0.6, 0.8, 1.0, 1.1, 1.2, 1.3, 1.4, 1.6, 2.0, 2.5];

/** 안정성 별점 5분위 경계에서 뽑은 대표 σ (domain/stability.ts) */
const SIGMAS = [0.008, 0.021, 0.037, 0.06];
const HORIZONS = [3, 7, 30, 90, 180];

/** 실력 = 하루 로그 드리프트 μ = skill·σ (simTierThresholds와 같은 모델) */
const COHORTS = [
  { name: '스팸(무정보)', skill: 0 },
  { name: '하위', skill: 0.08 },
  { name: '준수', skill: 0.2 },
  { name: '우수', skill: 0.35 },
  { name: '정밀', skill: 0.5 },
];

// ── 난수 (재현 가능) ──────────────────────────────────────────
// mulberry32 — LCG는 쓰지 않는다. 낮은 비트의 직렬 상관이 **긴 경로에서 누적**되어
// 90일 카드의 도달률만 체계적으로 빗나갔다(실제로 −7%p 오차로 나타났다).
let seed = 20260813;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Box–Muller. 두 정규난수를 다 쓴다 — 하나를 버리면 표본이 절반만 남는다 */
let spare: number | null = null;
function normal(): number {
  if (spare !== null) {
    const s = spare;
    spare = null;
    return s;
  }
  const u = Math.max(1e-12, rand());
  const r = Math.sqrt(-2 * Math.log(u));
  const th = 2 * Math.PI * rand();
  spare = r * Math.sin(th);
  return r * Math.cos(th);
}

/**
 * 일봉 종가 경로 몬테카를로 — 기한 안에 종가가 목표에 닿는 비율.
 * 판정 규칙과 같은 관측을 쓴다: **종가만** 본다(장중 고저 없음).
 */
function touchRate(
  sigma: number,
  days: number,
  magnitudePct: number,
  direction: Direction,
  skill: number,
): number {
  const target = direction === 'UP' ? Math.log(1 + magnitudePct / 100) : Math.log(1 - magnitudePct / 100);
  const drift = skill * sigma * (direction === 'UP' ? 1 : -1) - 0.5 * sigma * sigma;
  let hits = 0;
  for (let t = 0; t < TRIALS; t++) {
    let x = 0;
    for (let d = 0; d < days; d++) {
      x += drift + sigma * normal();
      if (direction === 'UP' ? x >= target : x <= target) {
        hits++;
        break;
      }
    }
  }
  return hits / TRIALS;
}

/** k → 예측 크기(%) */
const floorPct = (k: number, sigma: number, days: number): number =>
  k * sigma * Math.sqrt(days) * 100;

function line(cells: (string | number)[], w = 10): string {
  return cells.map((c) => String(c).padStart(w)).join('');
}

// ══════════════════════════════════════════════════════════════
console.log('\n════ ① σ 불변성 — 하한을 σ·√H에 비례시키면 p₀가 종목과 무관해지는가\n');
console.log('(각 칸 = 하한 카드의 무정보 도달 확률 p₀. 세로로 같으면 종목 선택이 무의미하다)\n');
for (const k of [0.8, 1.2, 1.6]) {
  console.log(`  k = ${k}`);
  console.log(`  ${line(['σ \\ 기한', ...HORIZONS.map((d) => `${d}일`)])}`);
  for (const sigma of SIGMAS) {
    const cells = HORIZONS.map((d) => {
      const p = noSkillTouchProbability('UP', floorPct(k, sigma, d), 'KR_EQUITY', d, sigma);
      return `${(p * 100).toFixed(1)}%`;
    });
    console.log(`  ${line([`${(sigma * 100).toFixed(1)}%`, ...cells])}`);
  }
  console.log('');
}

console.log('  [대조군] 지금의 고정 하한 5%\n');
console.log(`  ${line(['σ \\ 기한', ...HORIZONS.map((d) => `${d}일`)])}`);
for (const sigma of SIGMAS) {
  const cells = HORIZONS.map((d) => {
    const p = noSkillTouchProbability('UP', 5, 'KR_EQUITY', d, sigma);
    return `${(p * 100).toFixed(1)}%`;
  });
  console.log(`  ${line([`${(sigma * 100).toFixed(1)}%`, ...cells])}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n\n════ ② 몬테카를로 검증 — 닫힌꼴 p₀가 실제 일봉 경로와 맞는가\n');
console.log(`(${TRIALS.toLocaleString()}경로, 종가만 관측 — 판정 규칙과 동일)\n`);
console.log(`  ${line(['k', 'σ', '기한', '하한%', '닫힌꼴', 'MC', '오차'], 9)}`);
for (const k of [0.8, 1.2, 1.6]) {
  for (const sigma of [0.008, 0.037]) {
    for (const days of [7, 30, 90]) {
      const m = floorPct(k, sigma, days);
      const closed = noSkillTouchProbability('UP', m, 'KR_EQUITY', days, sigma);
      const mc = touchRate(sigma, days, m, 'UP', 0);
      console.log(
        `  ${line(
          [
            k,
            `${(sigma * 100).toFixed(1)}%`,
            `${days}일`,
            `${m.toFixed(1)}%`,
            `${(closed * 100).toFixed(1)}%`,
            `${(mc * 100).toFixed(1)}%`,
            `${((closed - mc) * 100).toFixed(1)}%p`,
          ],
          9,
        )}`,
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════
console.log('\n\n════ ③ k 스윕 — 실력이 가장 잘 보상되는 하한은 어디인가\n');
console.log('(σ=2.1%·30일 기준. EV는 신뢰도 1, 지분 B=10·M. MC 적중률)\n');
console.log(
  `  ${line(['k', '하한%', '무정보', '준수', '우수', '정밀', 'EV준수', 'EV우수', 'EV정밀'], 9)}`,
);
const REF_SIGMA = 0.021;
const REF_DAYS = 30;
let best = { k: 0, ev: -Infinity };
for (const k of K_GRID) {
  const m = floorPct(k, REF_SIGMA, REF_DAYS);
  const B = 10 * m;
  const p0 = touchRate(REF_SIGMA, REF_DAYS, m, 'UP', 0);
  const rates = COHORTS.map((c) => touchRate(REF_SIGMA, REF_DAYS, m, 'UP', c.skill));
  const ev = (p: number) => B * (p - p0);
  if (ev(rates[2]) > best.ev) best = { k, ev: ev(rates[2]) };
  console.log(
    `  ${line(
      [
        k,
        `${m.toFixed(1)}%`,
        `${(p0 * 100).toFixed(1)}%`,
        `${(rates[2] * 100).toFixed(1)}%`,
        `${(rates[3] * 100).toFixed(1)}%`,
        `${(rates[4] * 100).toFixed(1)}%`,
        ev(rates[2]).toFixed(0),
        ev(rates[3]).toFixed(0),
        ev(rates[4]).toFixed(0),
      ],
      9,
    )}`,
  );
}
console.log(`\n  → 준수 실력 기준 최적 k ≈ ${best.k}`);

// ── 최적 k가 종목·기간에 걸쳐 안정적인가 ──────────────────────
console.log('\n  [강건성] (σ, 기한) 칸마다 준수 실력의 EV를 최대화하는 k\n');
console.log(`  ${line(['σ \\ 기한', ...HORIZONS.map((d) => `${d}일`)])}`);
for (const sigma of SIGMAS) {
  const cells = HORIZONS.map((days) => {
    let bestK = 0;
    let bestEv = -Infinity;
    for (const k of K_GRID) {
      const m = floorPct(k, sigma, days);
      const p0 = touchRate(sigma, days, m, 'UP', 0);
      const p = touchRate(sigma, days, m, 'UP', 0.2);
      const ev = 10 * m * (p - p0);
      if (ev > bestEv) {
        bestEv = ev;
        bestK = k;
      }
    }
    return String(bestK);
  });
  console.log(`  ${line([`${(sigma * 100).toFixed(1)}%`, ...cells])}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n\n════ ④ 변동성 파밍 — 거친 종목만 골랐을 때 무엇을 얻는가\n');
console.log('(무정보자가 σ=0.8% 대신 σ=6.0% 종목을 고른다. 30일 카드)\n');
for (const label of ['고정 5%', 'k=1.2 σ연동'] as const) {
  const quiet = label === '고정 5%' ? 5 : floorPct(1.2, 0.008, 30);
  const wild = label === '고정 5%' ? 5 : floorPct(1.2, 0.06, 30);
  const pQuiet = touchRate(0.008, 30, quiet, 'UP', 0);
  const pWild = touchRate(0.06, 30, wild, 'UP', 0);
  console.log(`  ${label}`);
  console.log(`    조용한 종목: 하한 ${quiet.toFixed(1)}% → 무정보 적중률 ${(pQuiet * 100).toFixed(1)}%`);
  console.log(`    거친 종목  : 하한 ${wild.toFixed(1)}% → 무정보 적중률 ${(pWild * 100).toFixed(1)}%`);
  console.log(`    파밍 이득  : ${((pWild - pQuiet) * 100).toFixed(1)}%p\n`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n════ ⑤ 하한 × 상한 창 — 게시 불가능한 조합이 생기지 않는가\n');
console.log('(하한 ≥ 상한이면 그 조합은 아예 게시할 수 없다)\n');
const K = 1.2;
let closedWindows = 0;
for (const assetClass of ['KR_EQUITY', 'CRYPTO'] as AssetClass[]) {
  console.log(`  ${assetClass}`);
  console.log(`  ${line(['σ \\ 기한', ...HORIZONS.map((d) => `${d}일`)], 14)}`);
  for (const sigma of [...SIGMAS, 0.1]) {
    const cells = HORIZONS.map((d) => {
      const lo = floorPct(K, sigma, d);
      const hi = maxMagnitudePct(assetClass, d);
      if (lo >= hi) closedWindows++;
      return `${lo.toFixed(0)}~${hi.toFixed(0)}%${lo >= hi ? ' ✗' : ''}`;
    });
    console.log(`  ${line([`${(sigma * 100).toFixed(1)}%`, ...cells], 14)}`);
  }
  console.log('');
}
console.log(`  창이 닫힌 조합: ${closedWindows}건`);

// ══════════════════════════════════════════════════════════════
// k의 수준을 정하는 기준. EV 최대화는 기간에 따라 최적 k가 1.1→2.5로 움직여
// (③ 강건성) 상수의 근거가 되지 못한다 — 실력을 드리프트로 두면 우위가 √기간으로
// 커지기 때문이다. 그래서 **적중률 표시가 실력의 신호로 남는가**를 직접 잰다:
// 무정보자가 시즌 20장을 뿌렸을 때 "승률 50% 이상"으로 보일 확률.
console.log('\n\n════ ⑦ 운으로 실력처럼 보일 확률 (시즌 20장, 승률 50%+ 로 표시될 확률)\n');

/** P(X ≥ x | n, p) */
function binomTail(n: number, x: number, p: number): number {
  let pmf = Math.pow(1 - p, n);
  let cdf = pmf;
  for (let i = 1; i < x; i++) {
    pmf *= ((n - i + 1) / i) * (p / (1 - p));
    cdf += pmf;
  }
  return 1 - cdf;
}

console.log(`  ${line(['k', '하한%', '무정보p₀', '무정보', '준수', '정밀'], 11)}`);
for (const k of K_GRID) {
  const m = floorPct(k, REF_SIGMA, REF_DAYS);
  const p0 = touchRate(REF_SIGMA, REF_DAYS, m, 'UP', 0);
  const pGood = touchRate(REF_SIGMA, REF_DAYS, m, 'UP', 0.2);
  const pFine = touchRate(REF_SIGMA, REF_DAYS, m, 'UP', 0.5);
  console.log(
    `  ${line(
      [
        k,
        `${m.toFixed(1)}%`,
        `${(p0 * 100).toFixed(1)}%`,
        `${(binomTail(20, 10, p0) * 100).toFixed(1)}%`,
        `${(binomTail(20, 10, pGood) * 100).toFixed(1)}%`,
        `${(binomTail(20, 10, pFine) * 100).toFixed(1)}%`,
      ],
      11,
    )}`,
  );
}
console.log('\n  (무정보 칸이 낮고 준수·정밀 칸이 높을수록 적중률 표시가 실력을 가려낸다)');

console.log('\n  [강건성] 기간을 바꿔도 같은 k에서 갈리는가 — 무정보 / 준수\n');
console.log(`  ${line(['k \\ 기한', ...HORIZONS.map((d) => `${d}일`)], 14)}`);
for (const k of [0.8, 1.0, 1.2, 1.4, 1.6]) {
  const cells = HORIZONS.map((days) => {
    const m = floorPct(k, REF_SIGMA, days);
    const p0 = touchRate(REF_SIGMA, days, m, 'UP', 0);
    const pg = touchRate(REF_SIGMA, days, m, 'UP', 0.2);
    return `${(binomTail(20, 10, p0) * 100).toFixed(0)}/${(binomTail(20, 10, pg) * 100).toFixed(0)}`;
  });
  console.log(`  ${line([k, ...cells], 14)}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n\n════ ⑥ 자산군 폴백 — σ를 못 쟀을 때 쓸 값\n');
for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
  const sigma = DAILY_SIGMA[assetClass];
  const cells = HORIZONS.map((d) => `${floorPct(K, sigma, d).toFixed(1)}%`);
  console.log(
    `  ${assetClass.padEnd(12)} σ̄=${(sigma * 100).toFixed(0)}%  현행 고정 ${PROFITABILITY_BASE_PCT[assetClass]}%  →  ${line(cells, 9)}`,
  );
}
console.log('');
