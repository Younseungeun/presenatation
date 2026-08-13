import {
  CONFIDENCE_RANGE,
  DAILY_SIGMA,
  DISCIPLINE_ALPHA,
  claimedProbability,
  disciplineFor,
  evidenceThreshold,
  magnitudeWeight,
  maxMagnitudePct,
  minMagnitudePct,
  noSkillTouchProbability,
  SCORE_SCALE,
} from '../src/domain/scoring';
import { MAX_ACTIVE_CARDS } from '../src/domain/publishReport';
import { aggregateEvidence, type EvidenceCard } from '../src/domain/evidence';
import type { AssetClass } from '../src/domain/constants';

// 자산군 분할이 회피 수단인가 — npx tsx scripts/simAssetClassSplit.ts
//
// ── 무엇을 묻나 ───────────────────────────────────────────────
// 증거 D는 **자산군별로** 쌓이고 규율도 자산군별로 걸린다("코인에서 못했다고 주식을
// 막지 마라"). 그런데 **동시 활성 카드 상한도 자산군별**이다(무표기 5장).
// 그러면 셋에 나눠 내는 사람은
//
//   · 동시에 여는 카드가 5장 → **15장**  (물량 3배)
//   · 증거는 세 저장고에 흩어져 **각각 따로** 문턱을 넘어야 한다
//
// 판매량은 3배인데 처분 문턱은 3개로 나뉜다. 이 비대칭이 실제로 이득인지 잰다.
//
// ⚠ 앞서 "나누면 자산군당 표본이 1/3"이라고 어림했던 것은 틀렸다. 한 자산군에
// 몰아서 자주 내면 카드가 더 많이 겹치고 상관 보정이 그만큼 깎으므로, 나눠 내면
// 게시 간격이 벌어져 덜 깎인다. 두 효과가 상쇄된다 — 그래서 어림이 아니라 측정이 필요하다.
//
// ── 게시 속도를 무엇이 정하나 ────────────────────────────────
// 활성 상한 C장과 기한 H일이면 한 자산군에서 지속 가능한 게시 간격은 **H/C일**이다
// (카드 한 장이 슬롯을 H일 점유하므로). 그래서 게시 속도를 임의로 두지 않고
// 상한에서 유도한다 — 표적은 언제나 슬롯을 꽉 채워 돌린다고 본다.

const SIGMA = DAILY_SIGMA.KR_EQUITY; // 세 자산군의 σ를 같게 둔다 — 분할 효과만 보려고
const H = 30;
const CAP = MAX_ACTIVE_CARDS.BRONZE; // 자산군당 동시 활성 5장
const GAP = H / CAP; // 자산군당 게시 간격 = 6일
const N = 6_000;
const RHO = 0.6;
const DAY = 86_400_000;
const RUNG1 = evidenceThreshold(DISCIPLINE_ALPHA[0]);
const CLASS_LIST: AssetClass[] = ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'];

type Behavior = { kind: 'EV' } | { kind: 'CLAIM'; c: number };
interface Cohort {
  name: string;
  k: number;
  weight: number;
  behavior: Behavior;
  target: boolean;
}
const COHORTS: Cohort[] = [
  { name: '정밀', k: 0.5, weight: 0.05, behavior: { kind: 'EV' }, target: false },
  { name: '우수', k: 0.35, weight: 0.24, behavior: { kind: 'EV' }, target: false },
  { name: '준수', k: 0.2, weight: 0.47, behavior: { kind: 'EV' }, target: false },
  { name: '하위', k: 0.08, weight: 0.14, behavior: { kind: 'EV' }, target: false },
  { name: '스팸', k: 0, weight: 0.04, behavior: { kind: 'EV' }, target: false },
  { name: '과장c8', k: 0.05, weight: 0.03, behavior: { kind: 'CLAIM', c: 8 }, target: true },
  { name: '허위c10', k: 0, weight: 0.03, behavior: { kind: 'CLAIM', c: 10 }, target: true },
];

let seed = 20260813;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
let spare: number | null = null;
function gauss(): number {
  if (spare !== null) {
    const v = spare;
    spare = null;
    return v;
  }
  const u = Math.max(1e-12, rand());
  const v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  spare = r * Math.sin(2 * Math.PI * v);
  return r * Math.cos(2 * Math.PI * v);
}
function ncdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t) + 0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
function invNcdf(p: number): number {
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ncdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
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
const cardInfo = (M: number, c: number, hit: boolean) => {
  const p0 = noSkillTouchProbability('UP', M, 'KR_EQUITY', H, SIGMA);
  const pHat = claimedProbability(p0, c);
  return hit ? Math.log(pHat / p0) : Math.log((1 - pHat) / (1 - p0));
};
const cardScore = (M: number, c: number, hit: boolean) =>
  SCORE_SCALE * magnitudeWeight('KR_EQUITY', M) * cardInfo(M, c, hit);

const FLOOR = minMagnitudePct('KR_EQUITY', SIGMA, H);
const CAP_M = maxMagnitudePct('KR_EQUITY', H, SIGMA);
const M_GRID = Array.from({ length: 14 }, (_, i) => FLOOR + (i * (CAP_M - FLOOR)) / 13);
const CLAIM_M = M_GRID[Math.floor(M_GRID.length * 0.6)];

const evCache = new Map<string, { M: number; c: number }>();
function bestStrategy(k: number, capC: number) {
  const key = `${k}:${capC}`;
  const memo = evCache.get(key);
  if (memo) return memo;
  let best = { M: FLOOR, c: CONFIDENCE_RANGE.min, ev: -Infinity };
  for (const M of M_GRID) {
    const p = touchProb(M, k);
    for (let c = CONFIDENCE_RANGE.min; c <= capC; c++) {
      const ev = p * cardScore(M, c, true) + (1 - p) * cardScore(M, c, false);
      if (ev > best.ev) best = { M, c, ev };
    }
  }
  evCache.set(key, best);
  return best;
}

interface Person {
  cohort: number;
  posted: number;
  loudCards: number;
  fired: boolean;
  /** 처음 발동한 날 (한 번도 안 걸리면 −1) */
  firedDay: number;
  /** 발동 전까지 판 ★4+ 카드 — 처분이 늦으면 이 값이 커진다 */
  loudBeforeFire: number;
}

/**
 * @param classes 몇 개 자산군에 나눠 내나 (1 = 몰아서, 3 = 나눠서)
 * @param days 관측 기간(증거는 리셋하지 않는다)
 * @param globalCap 자산군을 합친 동시 활성 상한. 없으면 자산군별 상한만 적용된다.
 *   피해가 물량에서 오므로 상한을 총량으로 묶으면 그만큼 줄어야 한다 — 얼마나 줄고
 *   어떤 대가를 치르는지가 이 인자의 질문이다.
 */
function run(classes: number, days: number, globalCap?: number): Person[] {
  const people: Person[] = [];
  const totalDays = days + H + 2;
  for (let i = 0; i < N; i++) {
    let r = rand();
    let ci = 0;
    for (; ci < COHORTS.length - 1; ci++) {
      if (r < COHORTS[ci].weight) break;
      r -= COHORTS[ci].weight;
    }
    const co = COHORTS[ci];

    // 자산군마다 시장 요인이 따로 있다 — 자산군 간 상관은 0으로 둔다(보정도 안 한다)
    const shocks: number[][] = [];
    for (let a = 0; a < classes; a++) {
      const s: number[] = [];
      for (let t = 0; t < totalDays; t++) s.push(gauss());
      shocks.push(s);
    }

    const posted: EvidenceCard[][] = Array.from({ length: classes }, () => []);
    let postedCount = 0;
    let loud = 0;
    let loudBeforeFire = 0;
    let fired = false;
    let firedDay = -1;

    // 슬롯을 꽉 채워 돌리는 속도로 낸다. 자산군당 쓸 수 있는 슬롯은
    // 자산군별 상한과 (있다면) 전체 상한을 나눈 것 중 작은 쪽이다.
    const slotsPerClass = globalCap == null ? CAP : Math.min(CAP, globalCap / classes);
    const gapRun = H / slotsPerClass; // 카드 한 장이 슬롯을 H일 점유한다
    const nextPost = Array.from({ length: classes }, () => 0);

    for (let day = 0; day <= days; day++) {
      for (let a = 0; a < classes; a++) {
        if (day < nextPost[a]) continue;
        nextPost[a] = day + gapRun;
        const cls = CLASS_LIST[a];

        // 그 자산군의 증거 — 판정이 끝난 카드만
        const judged = posted[a].filter((c) => c.closedAt / DAY <= day);
        const evidence = aggregateEvidence(judged)[cls];
        const d = disciplineFor(evidence);
        if (evidence <= RUNG1 && !fired) {
          fired = true;
          firedDay = day;
          loudBeforeFire = loud;
        }
        if (d.publishSuspended) continue;

        let M: number;
        let c: number;
        if (co.behavior.kind === 'EV') {
          const s = bestStrategy(co.k, d.maxConfidence);
          M = s.M;
          c = s.c;
        } else {
          M = CLAIM_M;
          c = Math.min(d.maxConfidence, co.behavior.c);
        }

        let sum = 0;
        for (let u = day; u < day + H; u++) sum += shocks[a][u];
        const x = Math.sqrt(RHO) * (sum / Math.sqrt(H)) + Math.sqrt(1 - RHO) * gauss();
        const hit = x > invNcdf(1 - touchProb(M, co.k));

        postedCount++;
        if (c >= 7 && co.k < 0.2) loud++;
        posted[a].push({
          assetClass: cls,
          direction: 'UP',
          openedAt: day * DAY,
          closedAt: (day + H) * DAY,
          info: cardInfo(M, c, hit),
        });
      }
    }
    if (!fired) loudBeforeFire = loud;
    people.push({ cohort: ci, posted: postedCount, loudCards: loud, fired, firedDay, loudBeforeFire });
  }
  return people;
}

function report(label: string, classes: number, days: number, globalCap?: number): void {
  const people = run(classes, days, globalCap);
  let harm = 0;
  let harmBefore = 0;
  let hitFire = 0;
  let targetN = 0;
  let falseFire = 0;
  let falseN = 0;
  let postedTarget = 0;
  let firedDaySum = 0;
  let firedDayN = 0;
  for (let i = 0; i < COHORTS.length; i++) {
    const g = people.filter((p) => p.cohort === i);
    if (g.length === 0) continue;
    harm += g.reduce((a, p) => a + p.loudCards, 0);
    harmBefore += g.reduce((a, p) => a + p.loudBeforeFire, 0);
    if (COHORTS[i].target) {
      hitFire += g.filter((p) => p.fired).length;
      targetN += g.length;
      postedTarget += g.reduce((a, p) => a + p.posted, 0);
      for (const p of g) {
        if (p.firedDay >= 0) {
          firedDaySum += p.firedDay;
          firedDayN++;
        }
      }
    } else {
      falseFire += g.filter((p) => p.fired).length;
      falseN += g.length;
    }
  }
  console.log(
    `  ${label.padEnd(14)}` +
      `${(postedTarget / Math.max(1, targetN)).toFixed(0).padStart(8)}` +
      `${(((hitFire / targetN) * 100).toFixed(0) + '%').padStart(9)}` +
      `${(firedDayN ? (firedDaySum / firedDayN).toFixed(0) + '일' : '—').padStart(9)}` +
      `${(((falseFire / falseN) * 100).toFixed(2) + '%').padStart(9)}` +
      `${(harmBefore / people.length).toFixed(2).padStart(11)}` +
      `${(harm / people.length).toFixed(2).padStart(9)}`,
  );
}

console.log(`\n■ 자산군 분할이 회피 수단인가 — σ=${(SIGMA * 100).toFixed(1)}%/일 · 기한 ${H}일 · n=${N}`);
console.log(`  자산군당 동시 활성 ${CAP}장 → 지속 가능 게시 간격 ${GAP}일 (슬롯을 꽉 채워 돌린다)`);
console.log(`  증거·규율은 자산군별. 자산군 간 상관은 0으로 둔다(보정 대상이 아니다)\n`);
console.log(
  `  ${'구성'.padEnd(14)}${'표적 게시'.padStart(8)}${'발동'.padStart(9)}${'발동 시점'.padStart(9)}${'오작동'.padStart(9)}${'발동전 ★4+'.padStart(11)}${'총 ★4+'.padStart(9)}`,
);
for (const days of [91, 364, 728]) {
  const label = days === 91 ? '1분기' : days === 364 ? '1년' : '2년';
  console.log(`  ── ${label} ──`);
  report('한 곳에 몰아', 1, days);
  report('셋에 나눠', 3, days);
}
console.log('');

// ── 전체 상한을 씌우면 ───────────────────────────────────────
// 피해가 물량에서 오므로 총량을 묶으면 그만큼 줄어야 한다. 얼마로 묶을지는
// 지어내지 않고 여기서 고른다. 기준 둘:
//   ① 한 분야 전문가(자산군 1개)가 손해를 보면 안 된다 → 전체 상한 ≥ 자산군별 5장
//   ② 셋을 다 하는 표적의 피해가 "몰아서 낸 경우"에 가까워야 한다
console.log('■ 전체(자산군 합산) 활성 상한을 씌웠을 때 — 1년');
console.log(
  `  ${'구성'.padEnd(14)}${'표적 게시'.padStart(8)}${'발동'.padStart(9)}${'발동 시점'.padStart(9)}${'오작동'.padStart(9)}${'발동전 ★4+'.padStart(11)}${'총 ★4+'.padStart(9)}`,
);
console.log('  ── 기준선 ──');
report('1군(상한 없음)', 1, 364);
report('3군(상한 없음)', 3, 364);
console.log('  ── 3군 + 전체 상한 ──');
for (const g of [5, 6, 8, 10, 12]) {
  report(`3군 · 전체 ${g}장`, 3, 364, g);
}
console.log('  ── 1군은 영향을 받으면 안 된다 ──');
for (const g of [5, 8]) {
  report(`1군 · 전체 ${g}장`, 1, 364, g);
}
console.log('');
