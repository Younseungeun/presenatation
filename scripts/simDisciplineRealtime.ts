import {
  CONFIDENCE_RANGE,
  DAILY_SIGMA,
  DISCIPLINE_ALPHA,
  claimedProbability,
  evidenceThreshold,
  magnitudeWeight,
  maxMagnitudePct,
  minMagnitudePct,
  noSkillTouchProbability,
  SCORE_SCALE,
  scoreJudgedCard,
} from '../src/domain/scoring';
import { aggregateEvidence, type EvidenceCard } from '../src/domain/evidence';

// 규율 래더의 **제품 효과**를 달력 시간으로 다시 잰다 — npx tsx scripts/simDisciplineRealtime.ts
//
// ── 왜 다시 재나 ──────────────────────────────────────────────
// simDisciplineLadder.ts는 카드를 **내자마자 판정**한다고 둔다(그 파일 32~35행이
// 독립 가정을 명시한다). 그래서 거기서 나온 제품 지표 — 실력 없이 ★4+로 팔린 카드
// 0.74 → 0.26장/인 — 는 세 가지를 못 본다:
//
//   ① **판정 지연**: 30일 카드를 4.5일 간격으로 내면 8번째 카드를 낼 때까지
//      판정된 카드가 하나도 없다. 그동안 래더는 발동할 수 없다
//   ② **시즌 경계**: 시즌 91일에 기한 30일이면 61일 이후 게시분은 다음 시즌에
//      판정된다 — 이번 시즌 증거에 **아예 들어오지 않는다**
//   ③ **상관과 보정**: 같은 기간에 열린 카드는 함께 맞고 함께 틀리며(evidence.ts),
//      보정이 증거를 깎는다
//
// ①②는 래더를 **약하게** 하고 ③도 약하게 한다. 즉 옛 수치는 낙관이다.
// 얼마나 낙관인지가 이 스크립트의 질문이다.
//
// 래더는 도메인 것(scoring.DISCIPLINE_LADDER, 1단 α=10%)을 그대로 쓴다.

const ASSET = 'KR_EQUITY' as const;
const SIGMA = DAILY_SIGMA[ASSET];
const H = 30; // 카드 기한(일)
const CARDS = 20; // 시즌 게시 목표
const SEASON_DAYS = 91; // 분기
const RHO = 0.6; // 완전히 겹칠 때의 상관
const N = 12_000;
const DAY = 86_400_000;
const GAP = SEASON_DAYS / CARDS;

/**
 * 증거를 리셋하지 않고 쌓는 기간(일)과 그동안 내는 카드 수.
 * 기본은 한 시즌 — 도메인이 시즌마다 D를 0에서 시작하기 때문이다.
 * ⑦에서 이 값을 늘려 "리셋하지 않으면 어떻게 되나"를 본다. 게시 간격은 그대로다.
 */
let WINDOW_DAYS = SEASON_DAYS;
let WINDOW_CARDS = CARDS;

type Behavior =
  | { kind: 'EV' } // 기대 점수 최대 = 정직 신고
  | { kind: 'CLAIM'; c: number } // 실력과 무관하게 c를 고정으로 부른다
  // 래더를 보면서 피한다 — 증거가 문턱에 다가오면 c를 낮춰 얼어붙게 하고,
  // 여유가 생기면 다시 크게 부른다. 외부 검토가 위험도 高로 꼽은 공격.
  | { kind: 'ADAPTIVE'; loud: number; safe: number; margin: number };
interface Cohort {
  name: string;
  k: number;
  weight: number;
  behavior: Behavior;
  target: boolean;
}

// simDisciplineLadder.ts와 같은 모집단 — 두 수치를 나란히 읽을 수 있어야 한다
const COHORTS: Cohort[] = [
  { name: '정밀', k: 0.5, weight: 0.05, behavior: { kind: 'EV' }, target: false },
  { name: '우수', k: 0.35, weight: 0.24, behavior: { kind: 'EV' }, target: false },
  { name: '준수', k: 0.2, weight: 0.47, behavior: { kind: 'EV' }, target: false },
  { name: '하위', k: 0.08, weight: 0.14, behavior: { kind: 'EV' }, target: false },
  { name: '스팸', k: 0, weight: 0.04, behavior: { kind: 'EV' }, target: false },
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

/** 실력 k(일 드리프트 k·σ)를 반영한 도달 확률 */
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
/** 거짓 신고자의 크기 선택 — 기본은 수익성 구간 상위(옛 시뮬과 같은 값) */
let CLAIM_M = M_GRID[Math.floor(M_GRID.length * 0.6)];

const evCache = new Map<string, { M: number; c: number; ev: number }>();
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

// ── 시즌 ─────────────────────────────────────────────────────
/** 어떤 가정으로 굴리는가 */
type Track =
  | 'INSTANT' // 옛 가정: 내자마자 판정, 카드 독립, 보정 없음
  | 'TIMED' // 달력 시간 + 상관 + 보정 (현실)
  | 'TIMED_NOSEASON'; // 시즌 경계만 없앤 것 — ②의 몫을 따로 보려고

interface Person {
  cohort: number;
  cards: number;
  fired: boolean;
  deepest2: boolean;
  suspended: boolean;
  loudCards: number;
  /** 발동 시점의 카드 번호 (한 번도 안 걸리면 −1) */
  firedAt: number;
  /** 시즌 끝의 증거 D — 왜 발동했는지/안 했는지 보려는 계측 */
  finalEvidence: number;
  /** 증거에 들어간 판정 카드 수 */
  judgedCount: number;
  /** 유효 장수 = 보정 없는 합 / 보정된 합 */
  effective: number;
}

const RUNG2 = evidenceThreshold(DISCIPLINE_ALPHA[1]); // −4.61

/**
 * 1단 α를 바꿔 가며 보려고 도메인 래더를 흉내 낸다.
 * 깊은 단 셋은 도메인 그대로이고 **1단 문턱만** 인자로 받는다.
 */
function disciplineAt(evidence: number, rung1: number) {
  if (evidence <= evidenceThreshold(DISCIPLINE_ALPHA[3])) {
    return { maxConfidence: 2, publishSuspended: true };
  }
  if (evidence <= evidenceThreshold(DISCIPLINE_ALPHA[2])) {
    return { maxConfidence: 2, publishSuspended: false };
  }
  if (evidence <= RUNG2) return { maxConfidence: 4, publishSuspended: false };
  if (evidence <= rung1) return { maxConfidence: 6, publishSuspended: false };
  return { maxConfidence: CONFIDENCE_RANGE.max, publishSuspended: false };
}

/**
 * 도메인의 겹친-비율 하중에 ρ̄를 끼운 것. ρ̄=1이면 도메인과 같은 값이다
 * (evidence.aggregateEvidence). 낮추면 덜 깎아 유효 장수가 늘지만, 보장이
 * 구성에서 실측으로 강등된다 — docs/score-discipline-sim.md의 길 A.
 */
function evidenceWithRhoBar(cards: readonly EvidenceCard[], rhoBar: number): number {
  if (rhoBar === 1) return aggregateEvidence(cards)[ASSET];
  let sum = 0;
  for (let i = 0; i < cards.length; i++) {
    const a = cards[i];
    const lenA = Math.max(1, a.closedAt - a.openedAt);
    let load = 1;
    for (let j = 0; j < cards.length; j++) {
      if (j === i) continue;
      const b = cards[j];
      const ov = Math.min(a.closedAt, b.closedAt) - Math.max(a.openedAt, b.openedAt);
      if (ov <= 0) continue;
      load += (rhoBar * ov) / Math.min(lenA, Math.max(1, b.closedAt - b.openedAt));
    }
    sum += a.info / load;
  }
  return sum;
}

function runSeason(
  track: Track,
  rung1 = evidenceThreshold(DISCIPLINE_ALPHA[0]),
  rhoBar = 1,
): Person[] {
  const people: Person[] = [];
  const totalDays = WINDOW_DAYS + H + 2;
  for (let i = 0; i < N; i++) {
    let r = rand();
    let ci = 0;
    for (; ci < COHORTS.length - 1; ci++) {
      if (r < COHORTS[ci].weight) break;
      r -= COHORTS[ci].weight;
    }
    const co = COHORTS[ci];

    // 시장 공통 요인 — 겹친 기간에 비례해 상관이 생긴다
    const shocks: number[] = [];
    for (let t = 0; t < totalDays; t++) shocks.push(gauss());

    /** 낸 카드 전부 (판정 여부와 무관) */
    const posted: EvidenceCard[] = [];
    let cards = 0;
    let loud = 0;
    let fired = false;
    let deep2 = false;
    let suspended = false;
    let firedAt = -1;

    for (let t = 0; t < WINDOW_CARDS; t++) {
      const openDay = track === 'INSTANT' ? t : Math.round(t * GAP);
      const closeDay = track === 'INSTANT' ? t : openDay + H;

      // 게시 시점의 증거 — **그때까지 판정이 끝났고, 이번 시즌에 판정된** 카드만.
      // INSTANT는 closeDay = openDay라 직전 카드까지 전부 들어온다(옛 가정).
      const judged = posted.filter((c) => {
        const close = c.closedAt / DAY;
        if (close > openDay) return false; // 아직 안 끝났다
        if (track !== 'TIMED_NOSEASON' && close > WINDOW_DAYS) return false; // 창 밖 = 다음 시즌 몫
        return true;
      });
      const evidence = evidenceWithRhoBar(judged, rhoBar);

      const d = disciplineAt(evidence, rung1);
      if (evidence <= rung1 && !fired) {
        fired = true;
        firedAt = t;
      }
      if (evidence <= RUNG2) deep2 = true;
      if (d.publishSuspended) {
        suspended = true;
        break;
      }

      let M: number;
      let c: number;
      if (co.behavior.kind === 'EV') {
        const s = bestStrategy(co.k, d.maxConfidence);
        M = s.M;
        c = s.c;
      } else if (co.behavior.kind === 'ADAPTIVE') {
        // 문턱까지 margin 안쪽이면 몸을 사린다 — 낮은 c는 정보량이 0에 가까워
        // D가 더 내려가지 않는다(얼어붙는다). 여유가 생기면 다시 크게 부른다
        const b = co.behavior;
        M = CLAIM_M;
        c = Math.min(d.maxConfidence, evidence <= rung1 + b.margin ? b.safe : b.loud);
      } else {
        M = CLAIM_M;
        c = Math.min(d.maxConfidence, co.behavior.c);
      }

      // 결과 — INSTANT는 독립, TIMED는 시장 요인이 겹친 기간만큼 상관을 만든다
      let x: number;
      if (track === 'INSTANT') {
        x = gauss();
      } else {
        let s = 0;
        for (let u = openDay; u < openDay + H; u++) s += shocks[u];
        x = Math.sqrt(RHO) * (s / Math.sqrt(H)) + Math.sqrt(1 - RHO) * gauss();
      }
      const hit = x > invNcdf(1 - touchProb(M, co.k));

      cards++;
      if (c >= 7 && co.k < 0.2) loud++;
      posted.push({
        assetClass: ASSET,
        direction: 'UP',
        openedAt: openDay * DAY,
        closedAt: closeDay * DAY,
        info: cardInfo(M, c, hit),
      });
    }
    // 시즌 끝의 증거 — 판정이 끝난(그리고 이번 시즌인) 카드 전부
    const finalJudged = posted.filter((c) => {
      const close = c.closedAt / DAY;
      return track === 'TIMED_NOSEASON' ? true : close <= WINDOW_DAYS;
    });
    const corrected = evidenceWithRhoBar(finalJudged, rhoBar);
    const raw = finalJudged.reduce((a, c) => a + c.info, 0);
    people.push({
      cohort: ci,
      cards,
      fired,
      deepest2: deep2,
      suspended,
      loudCards: loud,
      firedAt,
      finalEvidence: corrected,
      judgedCount: finalJudged.length,
      effective: raw === 0 ? 0 : corrected / (raw / Math.max(1, finalJudged.length)),
    });
  }
  return people;
}

// ── 출력 ─────────────────────────────────────────────────────
function evaluate(label: string, track: Track, rung1?: number): void {
  const people = runSeason(track, rung1);
  console.log(`\n─── ${label} ───`);
  console.log(
    `  ${'코호트'.padEnd(8)}${'n'.padStart(6)}${'발동'.padStart(8)}${'2단+'.padStart(8)}${'정지'.padStart(7)}${'게시'.padStart(7)}${'★4+ 카드'.padStart(10)}` +
      `${'판정'.padStart(7)}${'유효'.padStart(7)}${'시즌말 D'.padStart(10)}`,
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
    const loud = g.reduce((a, p) => a + p.loudCards, 0) / g.length;
    harm += g.reduce((a, p) => a + p.loudCards, 0);
    if (COHORTS[i].target) {
      hitFire += g.filter((p) => p.fired).length;
      targetN += g.length;
    } else {
      falseFire += g.filter((p) => p.fired).length;
      falseDeep += g.filter((p) => p.deepest2).length;
      falseN += g.length;
    }
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    console.log(
      `  ${COHORTS[i].name.padEnd(8)}${String(g.length).padStart(6)}` +
        `${pct(g.filter((p) => p.fired).length / g.length).padStart(8)}` +
        `${pct(g.filter((p) => p.deepest2).length / g.length).padStart(8)}` +
        `${pct(g.filter((p) => p.suspended).length / g.length).padStart(7)}` +
        `${(g.reduce((a, p) => a + p.cards, 0) / g.length).toFixed(1).padStart(7)}` +
        `${loud.toFixed(2).padStart(10)}` +
        `${(g.reduce((a, p) => a + p.judgedCount, 0) / g.length).toFixed(1).padStart(7)}` +
        `${(g.reduce((a, p) => a + p.effective, 0) / g.length).toFixed(1).padStart(7)}` +
        `${(g.reduce((a, p) => a + p.finalEvidence, 0) / g.length).toFixed(2).padStart(10)}`,
    );
  }
  console.log(
    `  ▸ 표적 발동 ${((hitFire / targetN) * 100).toFixed(1)}% · ` +
      `오작동 ${((falseFire / falseN) * 100).toFixed(2)}% (2단+ ${((falseDeep / falseN) * 100).toFixed(2)}%) · ` +
      `실력 없이 ★4+로 팔린 카드 ${(harm / people.length).toFixed(2)}장/인`,
  );
}

console.log(`\n■ ${ASSET} σ=${(SIGMA * 100).toFixed(1)}%/일 · 기한 ${H}일 · 시즌 ${SEASON_DAYS}일에 ${CARDS}장(간격 ${GAP.toFixed(1)}일)`);
console.log(`  크기 ${FLOOR.toFixed(1)}~${CAP.toFixed(1)}% · 신뢰도 ${CONFIDENCE_RANGE.min}~${CONFIDENCE_RANGE.max} · ρ=${RHO} · n=${N}`);
console.log(`  래더는 도메인 것 그대로 (1단 α=10%, 문턱 −2.30)\n`);

console.log('■ 규율 없이 두면 (비교 기준)');
{
  // 래더를 끄고 굴리려면 증거를 0으로 고정해야 하는데, 그것은 disciplineFor의
  // 인자를 0으로 주는 것과 같다. 별도 트랙 없이 손으로 센다.
  let harm = 0;
  let n = 0;
  for (const co of COHORTS) {
    if (co.behavior.kind !== 'CLAIM' || co.k >= 0.2) continue;
    if (co.behavior.c >= 7) harm += co.weight * CARDS;
    n++;
  }
  void n;
  console.log(`  실력 없이 ★4+로 팔린 카드 ${harm.toFixed(2)}장/인 (제약이 없으면 표적이 20장을 그대로 판다)`);
}

evaluate('① 옛 가정 — 내자마자 판정 · 카드 독립 · 보정 없음', 'INSTANT');
evaluate('② 달력 시간 + 상관 + 보정 (현실)', 'TIMED');
evaluate('③ ②에서 시즌 경계만 없앰 — 경계의 몫을 따로 본다', 'TIMED_NOSEASON');

// ── 1단 α 민감도 — 현실 트랙에서 ────────────────────────────
// ②의 허위c10이 시즌말 D −2.22로 문턱 −2.30을 0.08 차이로 못 넘는다.
// 칼날 위라 α를 조금만 움직여도 결과가 뒤집힌다. 어디서 뒤집히는지 본다.
console.log('\n■ ④ 1단 α 민감도 (현실 트랙) — 깊은 단 셋은 도메인 그대로');
console.log(
  `  ${'1단 α'.padEnd(8)}${'문턱'.padStart(8)}${'표적 발동'.padStart(11)}${'오작동'.padStart(9)}${'2단+'.padStart(8)}${'★4+ 카드'.padStart(10)}`,
);
for (const alpha of [0.1, 0.2, 0.3, 0.4, 0.5] as const) {
  const th = evidenceThreshold(alpha);
  const people = runSeason('TIMED', th);
  let harm = 0;
  let hitFire = 0;
  let targetN = 0;
  let falseFire = 0;
  let falseDeep = 0;
  let falseN = 0;
  for (let i = 0; i < COHORTS.length; i++) {
    const g = people.filter((p) => p.cohort === i);
    harm += g.reduce((a, p) => a + p.loudCards, 0);
    if (COHORTS[i].target) {
      hitFire += g.filter((p) => p.fired).length;
      targetN += g.length;
    } else {
      falseFire += g.filter((p) => p.fired).length;
      falseDeep += g.filter((p) => p.deepest2).length;
      falseN += g.length;
    }
  }
  console.log(
    `  ${((alpha * 100).toFixed(0) + '%').padEnd(8)}${th.toFixed(2).padStart(8)}` +
      `${(((hitFire / targetN) * 100).toFixed(1) + '%').padStart(11)}` +
      `${(((falseFire / falseN) * 100).toFixed(2) + '%').padStart(9)}` +
      `${(((falseDeep / falseN) * 100).toFixed(2) + '%').padStart(8)}` +
      `${(harm / people.length).toFixed(2).padStart(10)}`,
  );
}
// ── 큰 목표가 회피 수단인가 ──────────────────────────────────
// p₀는 목표가 클수록 작아지고 하한 1%에서 눌린다. 그러면 p̂도 함께 작아져
// **못 맞히는 것이 약한 증거**가 된다(ln((1−p̂)/(1−p₀)) → 0). 설계상 옳은 성질이지만
// (어차피 닿기 어려운 목표를 놓친 것은 정보가 적다), 거짓 신고자가 그것을 고를 수 있다.
console.log('■ ⑤ 표적이 고르는 목표 크기에 따라 (현실 트랙 · 1단 α=10%)');
console.log(
  `  ${'목표 M'.padEnd(9)}${'p₀'.padStart(8)}${'c10 p̂'.padStart(9)}${'실패 정보량'.padStart(12)}` +
    `${'표적 발동'.padStart(11)}${'★4+ 카드'.padStart(10)}`,
);
const M_SAVE = CLAIM_M;
for (const frac of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
  CLAIM_M = M_GRID[Math.min(M_GRID.length - 1, Math.floor(M_GRID.length * frac))];
  evCache.clear();
  const p0 = noSkillTouchProbability('UP', CLAIM_M, ASSET, H, SIGMA);
  const pHat = claimedProbability(p0, 10);
  const missInfo = Math.log((1 - pHat) / (1 - p0));
  const people = runSeason('TIMED');
  let harm = 0;
  let hitFire = 0;
  let targetN = 0;
  for (let i = 0; i < COHORTS.length; i++) {
    const g = people.filter((p) => p.cohort === i);
    harm += g.reduce((a, p) => a + p.loudCards, 0);
    if (COHORTS[i].target) {
      hitFire += g.filter((p) => p.fired).length;
      targetN += g.length;
    }
  }
  console.log(
    `  ${(CLAIM_M.toFixed(1) + '%').padEnd(9)}${((p0 * 100).toFixed(1) + '%').padStart(8)}` +
      `${((pHat * 100).toFixed(0) + '%').padStart(9)}${missInfo.toFixed(2).padStart(12)}` +
      `${(((hitFire / targetN) * 100).toFixed(1) + '%').padStart(11)}` +
      `${(harm / people.length).toFixed(2).padStart(10)}`,
  );
}
CLAIM_M = M_SAVE;
evCache.clear();
console.log('');

// ── 보정을 완화하면 되살아나는가 ─────────────────────────────
// 약화가 두 겹이다: 유효 장수 20 → 2.6(보정 + 시즌 경계)과 카드당 −3.28 → −0.87
// (목표 크기). ρ̄를 낮추면 첫 번째가 풀린다. 두 겹이 곱해지므로 α만으로는 안 됐다.
console.log('■ ⑥ 하중 완화(ρ̄) × 1단 α — 현실 트랙, 표적은 기본 크기(35.8%)');
console.log(
  `  ${'ρ̄'.padEnd(7)}${'α'.padStart(6)}${'유효 장수'.padStart(11)}${'표적 발동'.padStart(11)}${'오작동'.padStart(9)}${'★4+ 카드'.padStart(10)}`,
);
for (const rb of [1.0, 0.7, 0.5] as const) {
  for (const alpha of [0.1, 0.2] as const) {
    const people = runSeason('TIMED', evidenceThreshold(alpha), rb);
    let harm = 0;
    let hitFire = 0;
    let targetN = 0;
    let falseFire = 0;
    let falseN = 0;
    let eff = 0;
    for (let i = 0; i < COHORTS.length; i++) {
      const g = people.filter((p) => p.cohort === i);
      harm += g.reduce((a, p) => a + p.loudCards, 0);
      eff += g.reduce((a, p) => a + p.effective, 0);
      if (COHORTS[i].target) {
        hitFire += g.filter((p) => p.fired).length;
        targetN += g.length;
      } else {
        falseFire += g.filter((p) => p.fired).length;
        falseN += g.length;
      }
    }
    console.log(
      `  ${rb.toFixed(1).padEnd(7)}${((alpha * 100).toFixed(0) + '%').padStart(6)}` +
        `${(eff / people.length).toFixed(1).padStart(11)}` +
        `${(((hitFire / targetN) * 100).toFixed(1) + '%').padStart(11)}` +
        `${(((falseFire / falseN) * 100).toFixed(2) + '%').padStart(9)}` +
        `${(harm / people.length).toFixed(2).padStart(10)}`,
    );
  }
}
console.log('');

// ── 리셋을 없애면 큰 목표 회피도 닫히는가 ────────────────────
// ⑤에서 목표를 키우는 것만으로 탐지가 67.5% → 0.0%가 됐다. 그 회피가 증거를
// 이어 쌓아도 남는지 본다. 남는다면 별도 장치(신뢰도 상한 등)가 필요하다.
console.log('■ ⑤-2 큰 목표 회피 × 증거 창 (표적 발동률 / 20장당 ★4+ 카드)');
console.log(
  `  ${'목표 M'.padEnd(9)}${'실패 정보량'.padStart(12)}` +
    (['1분기', '1년', '2년'] as const).map((s) => s.padStart(16)).join(''),
);
const M_SAVE2 = CLAIM_M;
const D2 = WINDOW_DAYS;
const C2 = WINDOW_CARDS;
for (const frac of [0, 0.4, 0.6, 1.0]) {
  CLAIM_M = M_GRID[Math.min(M_GRID.length - 1, Math.floor(M_GRID.length * frac))];
  evCache.clear();
  const p0 = noSkillTouchProbability('UP', CLAIM_M, ASSET, H, SIGMA);
  const missInfo = Math.log((1 - claimedProbability(p0, 10)) / (1 - p0));
  const cells = ([[91, 20], [364, 80], [728, 160]] as const).map(([days, cards]) => {
    WINDOW_DAYS = days;
    WINDOW_CARDS = cards;
    const people = runSeason('TIMED');
    let harm = 0;
    let hitFire = 0;
    let targetN = 0;
    for (let i = 0; i < COHORTS.length; i++) {
      const g = people.filter((p) => p.cohort === i);
      harm += g.reduce((a, p) => a + p.loudCards, 0);
      if (COHORTS[i].target) {
        hitFire += g.filter((p) => p.fired).length;
        targetN += g.length;
      }
    }
    const per20 = (harm / people.length) * (20 / cards);
    return `${((hitFire / targetN) * 100).toFixed(0)}% / ${per20.toFixed(2)}`.padStart(16);
  });
  console.log(
    `  ${(CLAIM_M.toFixed(1) + '%').padEnd(9)}${missInfo.toFixed(2).padStart(12)}${cells.join('')}`,
  );
}
CLAIM_M = M_SAVE2;
WINDOW_DAYS = D2;
WINDOW_CARDS = C2;
evCache.clear();
console.log('');

// ── 시즌 리셋이 래더를 죽이는가 ──────────────────────────────
// D는 시즌마다 0에서 시작한다. 유효 장수가 2.6인 창에서 리셋하면 증거가 쌓일 자리가
// 없다. 게시 간격을 그대로 두고 **창만 늘려** 본다 (리셋 없이 이어 쌓는 경우).
console.log('■ ⑦ 증거를 리셋하지 않고 쌓으면 (게시 간격 4.5일 고정 · ρ̄=1 · α=10%)');
console.log(
  `  ${'창'.padEnd(12)}${'게시'.padStart(7)}${'판정'.padStart(7)}${'유효'.padStart(7)}` +
    `${'표적 발동'.padStart(11)}${'오작동'.padStart(9)}${'★4+/20장'.padStart(11)}`,
);
const D_SAVE = WINDOW_DAYS;
const C_SAVE = WINDOW_CARDS;
for (const [days, cards, label] of [
  [91, 20, '1분기'],
  [182, 40, '2분기'],
  [364, 80, '1년'],
  [728, 160, '2년'],
] as const) {
  WINDOW_DAYS = days;
  WINDOW_CARDS = cards;
  const people = runSeason('TIMED');
  let harm = 0;
  let hitFire = 0;
  let targetN = 0;
  let falseFire = 0;
  let falseN = 0;
  let eff = 0;
  let judged = 0;
  let posted = 0;
  for (let i = 0; i < COHORTS.length; i++) {
    const g = people.filter((p) => p.cohort === i);
    harm += g.reduce((a, p) => a + p.loudCards, 0);
    eff += g.reduce((a, p) => a + p.effective, 0);
    judged += g.reduce((a, p) => a + p.judgedCount, 0);
    posted += g.reduce((a, p) => a + p.cards, 0);
    if (COHORTS[i].target) {
      hitFire += g.filter((p) => p.fired).length;
      targetN += g.length;
    } else {
      falseFire += g.filter((p) => p.fired).length;
      falseN += g.length;
    }
  }
  // 피해는 창 길이에 비례해 커지므로 20장당으로 환산해 비교한다
  const per20 = (harm / people.length) * (20 / cards);
  console.log(
    `  ${label.padEnd(12)}${(posted / people.length).toFixed(1).padStart(7)}` +
      `${(judged / people.length).toFixed(1).padStart(7)}${(eff / people.length).toFixed(1).padStart(7)}` +
      `${(((hitFire / targetN) * 100).toFixed(1) + '%').padStart(11)}` +
      `${(((falseFire / falseN) * 100).toFixed(2) + '%').padStart(9)}` +
      `${per20.toFixed(2).padStart(11)}`,
  );
}
WINDOW_DAYS = D_SAVE;
WINDOW_CARDS = C_SAVE;
console.log('');

// ── 적응형 표적 — 래더를 보면서 피한다 ───────────────────────
// 외부 검토가 위험도 高로 꼽았다: 증거가 문턱에 다가오면 c를 낮춰 얼어붙게 하고,
// 여유가 생기면 다시 크게 부른다. 고정 c 표적과 나란히 놓고 본다.
console.log('■ ⑧ 적응형 표적 (문턱 0.8 안쪽이면 c=2로 몸을 사린다)');
COHORTS.push({
  name: '적응형',
  k: 0,
  weight: 0,
  behavior: { kind: 'ADAPTIVE', loud: 10, safe: 2, margin: 0.8 },
  target: true,
});
// 표적 셋을 적응형으로 바꿔 같은 비중에서 비교한다
const FIXED = COHORTS.map((c) => ({ ...c }));
console.log(
  `  ${'창'.padEnd(10)}${'표적'.padStart(10)}${'발동'.padStart(9)}${'★4+/20장'.padStart(11)}${'게시'.padStart(8)}`,
);
for (const [days, cards, label] of [
  [91, 20, '1분기'],
  [364, 80, '1년'],
  [728, 160, '2년'],
] as const) {
  WINDOW_DAYS = days;
  WINDOW_CARDS = cards;
  for (const mode of ['고정 c10', '적응형'] as const) {
    // 허위c10 코호트의 행동만 갈아 끼운다
    const idx = COHORTS.findIndex((c) => c.name === '허위c10');
    COHORTS[idx].behavior =
      mode === '적응형'
        ? { kind: 'ADAPTIVE', loud: 10, safe: 2, margin: 0.8 }
        : { kind: 'CLAIM', c: 10 };
    const people = runSeason('TIMED');
    const g = people.filter((p) => p.cohort === idx);
    const per20 = (g.reduce((a, p) => a + p.loudCards, 0) / g.length) * (20 / cards);
    console.log(
      `  ${label.padEnd(10)}${mode.padStart(10)}` +
        `${((g.filter((p) => p.fired).length / g.length) * 100).toFixed(0).padStart(8)}%` +
        `${per20.toFixed(2).padStart(11)}` +
        `${(g.reduce((a, p) => a + p.cards, 0) / g.length).toFixed(1).padStart(8)}`,
    );
  }
}
COHORTS.length = 0;
COHORTS.push(...FIXED.filter((c) => c.name !== '적응형'));
COHORTS[COHORTS.findIndex((c) => c.name === '허위c10')].behavior = { kind: 'CLAIM', c: 10 };
WINDOW_DAYS = D_SAVE;
WINDOW_CARDS = C_SAVE;
console.log('');
