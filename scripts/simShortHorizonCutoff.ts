import type { AssetClass, Direction } from '../src/domain/constants';
import {
  CONFIDENCE_RANGE,
  SCORE_SCALE,
  claimedProbability,
  magnitudeWeight,
  minMagnitudePct,
  noSkillTouchProbability,
} from '../src/domain/scoring';
import { DEFAULT_TIER_THRESHOLDS } from '../src/domain/tiers';

// 주식 단기 카드 컷오프 문턱 캘리브레이션 — npm run sim:cutoff
//
// ── 묻는 것 ──────────────────────────────────────────────────────
// `EQUITY_SHORT_HORIZON_DAYS`(현재 7)는 **주식 카드가 언제 특별 취급을 받는가**를 정한다.
//   · 시한 ≥ 문턱 → FIXED_AT_PUBLISH: 기준가 = **게시 순간 가격**, 아무 때나 게시 가능
//   · 시한 < 문턱 → 컷오프 규칙: 개장 전에 내거나(기준가 = 어제 종가), 시한을 +2일 이상으로
//
// 이 숫자에는 **근거가 기록돼 있지 않다.** 이 코드베이스의 다른 문턱은 전부 재서 정했다
// (크기 하한 k=1.2, 판매 중단 α=0.5, 안정성 눈금 300종목 표집). 여기만 비어 있어 잰다.
//
// ── 무엇이 새는가 ────────────────────────────────────────────────
// FIXED_AT_PUBLISH의 기준가는 **장중 한 순간의 가격**인데 판정은 **종가**로 한다.
// 그 사이가 벌어져 있고, 게시 시각은 리서처가 고른다 — **예측력이 전혀 없어도**
// 그날 눌린 순간에 상승 카드를 내면 목표선이 그만큼 가까워진다. 호가 튐·장중 되돌림을
// 기다리는 것뿐이라 분석이 필요 없다.
//
// 모델 p₀(noSkillTouchProbability)는 기준가를 **그 구간의 정직한 출발점**으로 가정한다.
// 고른 순간이 출발점이면 **실제 도달 확률 p_real이 모델 p₀보다 높아지고**, 그 차이가
// 곧 실력 없이 얻는 점수다. σ 추정기를 고칠 때 쓴 잣대와 같다
// ("σ 오차만으로 얻는 카드당 기대 점수" — 정확하면 반드시 0).
//
// ── 왜 컷오프 규칙 쪽에는 이 구멍이 없나 ─────────────────────────
//   · 개장 전 게시 → 기준가 = **직전 거래일 종가**. 이미 확정된 공개 숫자라 고를 수 없다
//   · 그 외 게시   → 기준가 = **게시 이후 첫 종가**. 아직 안 일어난 값이라 고를 수 없다
// 그래서 새는 곳은 FIXED_AT_PUBLISH 하나뿐이고, 문턱은 "언제부터 새도 괜찮은가"다.

const PATHS = 30_000;
/** 정규장 6.5시간을 5분봉으로 — 게시 시각의 해상도 */
const TICKS_PER_DAY = 78;
const HORIZON_GRID = [1, 2, 3, 5, 7, 10, 14, 21, 30, 60];

/** 안정성 별점 5분위 대표 σ (domain/stability.ts 눈금에서 뽑음) */
const SIGMAS = [
  { label: '★5 조용함', sigma: 0.018 },
  { label: '★3 보통', sigma: 0.037 },
  { label: '★1 거침', sigma: 0.07 },
];
const DIRECTIONS: Direction[] = ['UP', 'DOWN'];
const ASSET: AssetClass = 'KR_EQUITY';

/** 시즌 카드 수 — 누적 피해 환산용 (simSkillSeparation와 같은 가정) */
const SEASON_CARDS = 20;
/** 시니어 승급선 — "이만큼이 실력 없이 채워진다"의 분모 */
const SENIOR = DEFAULT_TIER_THRESHOLDS.SILVER;

// ── 난수 (mulberry32 + Box–Muller) ────────────────────────────
// LCG는 쓰지 않는다 — 낮은 비트의 직렬 상관이 긴 경로에서 누적돼 도달률을 계통적으로
// 빗나가게 한다(크기 하한 시뮬에서 90일 경로 −7%p 편향으로 실제 관측됐다).
let seed = 20260816;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
let spare: number | null = null;
function normal(): number {
  if (spare !== null) {
    const v = spare;
    spare = null;
    return v;
  }
  let u = 0;
  let v = 0;
  let s = 0;
  do {
    u = rand() * 2 - 1;
    v = rand() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const f = Math.sqrt((-2 * Math.log(s)) / s);
  spare = v * f;
  return u * f;
}

/** 무실력자 = 드리프트 0의 기하 브라운 운동 (마팅게일 보정 −σ²/2) */
function step(logPrice: number, sigma: number): number {
  return logPrice + (-0.5 * sigma * sigma + sigma * normal());
}

interface Trial {
  /** 기준가 대비 목표 도달 여부 */
  hit: boolean;
}

/**
 * 경로 1개.
 *
 * `opportunistic`이면 **게시일 중 자기에게 가장 유리한 틱**에 게시한다(상승이면 최저).
 * 예측력이 아니라 **기다림**만 필요한 행동이라 이것이 정직한 상한이다.
 * 비교군(false)은 아무 틱에서나 게시 — 이 둘의 차이가 곧 "시각을 고른 값어치"다.
 */
function runPath(
  direction: Direction,
  sigma: number,
  horizonDays: number,
  floorPct: number,
  opportunistic: boolean,
): Trial {
  const tickSigma = sigma / Math.sqrt(TICKS_PER_DAY);
  // ── 게시일 장중 ──
  let logP = 0;
  const ticks: number[] = [logP];
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    logP = step(logP, tickSigma);
    ticks.push(logP);
  }
  // 게시 가능한 시각: 장중 어디든. 마지막 틱(종가)에는 게시하지 않는다(그건 장 마감 후다)
  const candidates = ticks.slice(0, TICKS_PER_DAY);
  let baseLog: number;
  if (opportunistic) {
    baseLog =
      direction === 'UP' ? Math.min(...candidates) : Math.max(...candidates);
  } else {
    baseLog = candidates[Math.floor(rand() * candidates.length)];
  }

  const target =
    direction === 'UP'
      ? baseLog + Math.log(1 + floorPct / 100)
      : baseLog + Math.log(1 - floorPct / 100);

  // ── 판정 구간: 게시일 종가 ~ 시한 종가 (일봉 종가만 본다) ──
  let extreme = ticks[TICKS_PER_DAY]; // 게시일 종가
  let closeLog = extreme;
  for (let d = 1; d < Math.max(1, Math.round(horizonDays)); d++) {
    // 하루치를 한 번에 굴린다 — 종가만 쓰므로 장중 해상도가 필요 없다
    closeLog = closeLog + (-0.5 * sigma * sigma + sigma * normal());
    extreme = direction === 'UP' ? Math.max(extreme, closeLog) : Math.min(extreme, closeLog);
  }
  const hit = direction === 'UP' ? extreme >= target : extreme <= target;
  return { hit };
}

/** 파머의 최적 신뢰도 — 사다리 위에서 기대 점수가 가장 큰 칸 */
function bestExpectedScore(p0: number, pReal: number, weight: number) {
  let best = { score: -Infinity, confidence: CONFIDENCE_RANGE.min };
  for (let c = CONFIDENCE_RANGE.min; c <= CONFIDENCE_RANGE.max; c++) {
    const claimed = claimedProbability(p0, c);
    const ev =
      SCORE_SCALE *
      weight *
      (pReal * Math.log(claimed / p0) + (1 - pReal) * Math.log((1 - claimed) / (1 - p0)));
    if (ev > best.score) best = { score: ev, confidence: c };
  }
  return best;
}

interface Row {
  horizonDays: number;
  floorPct: number;
  p0: number;
  pRealOpportunistic: number;
  pRealRandom: number;
  scorePerCard: number;
  seasonScore: number;
  seniorPct: number;
  confidence: number;
}

function measure(sigma: number, horizonDays: number): Row {
  const floorPct = minMagnitudePct(ASSET, sigma, horizonDays);
  const weight = magnitudeWeight(ASSET, floorPct);

  let hitsOpp = 0;
  let hitsRnd = 0;
  let n = 0;
  for (const direction of DIRECTIONS) {
    for (let i = 0; i < PATHS; i++) {
      if (runPath(direction, sigma, horizonDays, floorPct, true).hit) hitsOpp++;
      if (runPath(direction, sigma, horizonDays, floorPct, false).hit) hitsRnd++;
      n++;
    }
  }
  const pRealOpportunistic = hitsOpp / n;
  const pRealRandom = hitsRnd / n;
  // 모델이 믿는 값 — 방향은 대칭이라 UP으로 대표한다
  const p0 = noSkillTouchProbability('UP', floorPct, ASSET, horizonDays, sigma);
  const best = bestExpectedScore(p0, pRealOpportunistic, weight);
  const scorePerCard = Math.max(0, best.score);
  const seasonScore = scorePerCard * SEASON_CARDS;
  return {
    horizonDays,
    floorPct,
    p0,
    pRealOpportunistic,
    pRealRandom,
    scorePerCard,
    seasonScore,
    seniorPct: (seasonScore / SENIOR) * 100,
    confidence: best.confidence,
  };
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

function main() {
  console.log('주식 단기 카드 컷오프 문턱 캘리브레이션');
  console.log(`경로 ${PATHS.toLocaleString()}개 × 방향 2 × 시한 ${HORIZON_GRID.length}종`);
  console.log(`장중 해상도 ${TICKS_PER_DAY}틱(5분봉) · 시즌 ${SEASON_CARDS}장 · 시니어 ${SENIOR}점\n`);
  console.log('공짜 점수 = "예측력 0인 사람이 게시 시각만 골라서 얻는 카드당 기대 점수"');
  console.log('(모델 p₀가 정확하면 반드시 0이다 — 0보다 크면 그만큼이 실력 없이 들어온다)\n');

  const byHorizon = new Map<number, number[]>();

  for (const { label, sigma } of SIGMAS) {
    console.log(`\n── ${label} (σ=${(sigma * 100).toFixed(1)}%/일) ${'─'.repeat(30)}`);
    console.log(
      '시한   하한     모델p₀   실제p(고름)  실제p(무작위)  공짜/카드   시즌20장   시니어대비',
    );
    for (const h of HORIZON_GRID) {
      const r = measure(sigma, h);
      byHorizon.set(r.horizonDays, [...(byHorizon.get(r.horizonDays) ?? []), r.seniorPct]);
      console.log(
        `${String(h).padStart(3)}일  ${r.floorPct.toFixed(1).padStart(5)}%  ` +
          `${pct(r.p0).padStart(6)}  ${pct(r.pRealOpportunistic).padStart(9)}  ` +
          `${pct(r.pRealRandom).padStart(11)}  ${r.scorePerCard.toFixed(1).padStart(8)}점  ` +
          `${r.seasonScore.toFixed(0).padStart(7)}점  ${r.seniorPct.toFixed(1).padStart(7)}%`,
      );
    }
  }

  // ── 문턱 후보 ─────────────────────────────────────────────
  console.log(`\n\n${'='.repeat(78)}`);
  console.log('문턱 후보 — 세 σ 중 **최악**을 기준으로 (가장 거친 종목을 고를 것이므로)');
  console.log('='.repeat(78));
  console.log('시한   시니어 대비 최악   판정');
  const BARS = [
    { bar: 5, label: '느슨 (5%)' },
    { bar: 2, label: '보통 (2%)' },
    { bar: 1, label: '엄격 (1%)' },
  ];
  const worst = new Map<number, number>();
  for (const [h, list] of byHorizon) worst.set(h, Math.max(...list));

  for (const h of HORIZON_GRID) {
    const w = worst.get(h)!;
    const marks = BARS.map((b) => (w <= b.bar ? '○' : '×')).join(' ');
    console.log(`${String(h).padStart(3)}일  ${w.toFixed(1).padStart(14)}%   ${marks}`);
  }
  console.log(`      ${' '.repeat(14)}    ${BARS.map((b) => b.label).join(' / ')}`);

  console.log('\n최소 문턱:');
  for (const b of BARS) {
    const first = HORIZON_GRID.find((h) => (worst.get(h) ?? Infinity) <= b.bar);
    console.log(
      `  ${b.label.padEnd(12)} → ${first ? `${first}일` : '이 격자 안에 없음'}` +
        `${first === undefined ? '' : ` (이 시한부터는 시각을 골라도 시즌 누적이 시니어선의 ${b.bar}% 이하)`}`,
    );
  }
  console.log('\n⚠ 이 수치는 "가장 유리한 틱을 고른다"는 상한 가정이다. 실제 리서처가 늘 그렇게');
  console.log('   행동하지는 않는다 — 무작위 게시 열과 비교하면 그 차이가 곧 기회주의의 값어치다.');
}

main();
