import { claimedProbability, DAILY_SIGMA, noSkillTouchProbability } from '../src/domain/scoring';
import { aggregateEvidence, type EvidenceCard } from '../src/domain/evidence';

// 묶음의 **전이적 연쇄** 검증 — npx tsx scripts/simEvidenceChaining.ts
//
// ── 왜 다시 재나 ──────────────────────────────────────────────
// simEvidenceCorrelation.ts는 카드를 "파도"로 냈다: openedAt = wv*1000,
// closedAt = +500. 파도끼리 절대 겹치지 않으므로 묶음이 파도 단위로 딱 끊긴다.
// 그런데 aggregateEvidence는 새 카드가 붙을 때마다 묶음의 끝을 민다:
//
//     found.to = Math.max(found.to, card.closedAt);
//
// 실제 리서처는 파도로 내지 않는다. 30일 카드를 4~5일 간격으로 꾸준히 내면
// 카드1[0,30] → 카드2[5,35] → 카드3[10,40] … 이 줄줄이 붙어 **시즌 전체가 한
// 묶음**이 된다. 카드1과 카드20은 3개월 떨어져 있어 조건부 신고 조건을 전혀
// 깨지 않는데도 함께 평균된다.
//
// ── 상관 모형 ─────────────────────────────────────────────────
// 시장 공통 요인을 **일별 충격**으로 둔다. 카드 i가 [a,b)를 살면
//     M_i = Σ_{t∈[a,b)} m_t / √(b−a)        (표준정규)
//     corr(M_i, M_j) = 겹친 일수 / √(len_i·len_j)
// 잠재변수 x_i = √ρ·M_i + √(1−ρ)·e_i → corr(x_i,x_j) = ρ · 겹침비율.
// 곧 **상관이 겹치는 기간에 비례해 감쇠한다** — 파도 모형(0 아니면 ρ)보다 실제에 가깝다.

const A = 'KR_EQUITY' as const;
const SIG = DAILY_SIGMA[A];
let H = 30; // 카드 기한(일)
let CARDS = 20; // 시즌 게시 수
const SEASON_DAYS = 91; // 분기
let RHO = 0.6; // 완전히 겹칠 때의 상관
let GROUP = 1; // 한 번에 몇 장씩 내나 (파도)
const N = 40_000;
const MAG = 15;
const THRESH = -3.0; // 1단 (α = 5%)

let P0 = noSkillTouchProbability('UP', MAG, A, H, SIG);

let seed = 20260813;
function rand(): number {
  seed |= 0;
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

const infoOf = (pHat: number, hit: boolean) =>
  hit ? Math.log(pHat / P0) : Math.log((1 - pHat) / (1 - P0));

// ── 묶음 방식 ────────────────────────────────────────────────
type Mode = 'NONE' | 'CHAIN' | 'ANCHOR' | 'DEGREE' | 'OVERLAP';

/**
 * 대안 3: **겹친 비율로 깎는다.** 차수 가중이 "하루라도 겹치면 한 장"으로 세는 것을
 * 고쳐, 겹친 정도만큼만 센다.
 *     w_i = 1 / (1 + Σ_{j≠i} 겹친일수(i,j) / min(len_i, len_j))
 * 완전히 겹친 n장 파도에서는 w=1/n이라 평균과 같다(캘리브레이션 유지).
 * 스쳐 지나가는 카드는 거의 깎지 않고, 긴 앵커 카드는 **자기 몫만 0에 가까워질 뿐**
 * 남의 몫을 삼키지 않는다.
 */
function overlapEvidence(cards: readonly EvidenceCard[]): number {
  let sum = 0;
  for (const a of cards) {
    let load = 1;
    for (const b of cards) {
      if (a === b) continue;
      if (a.assetClass !== b.assetClass || a.direction !== b.direction) continue;
      const ov = Math.min(a.closedAt, b.closedAt) - Math.max(a.openedAt, b.openedAt);
      if (ov <= 0) continue;
      const shorter = Math.min(a.closedAt - a.openedAt, b.closedAt - b.openedAt);
      load += ov / Math.max(1, shorter);
    }
    sum += a.info / load;
  }
  return sum;
}

/**
 * 대안 2: **차수 가중.** 카드 i가 자기와 기간이 겹치는 카드 수 d_i로 나뉜다.
 *     D = Σ info_i / d_i
 * 묶음을 만들지 않으므로 순서·경계가 없다. 동시 n장 파도에서는 d=n이라
 * 정확히 평균이 되어 기존 보정과 같은 값을 낸다(캘리브레이션 유지).
 * 긴 카드 한 장은 자기 차수만 커질 뿐 남의 몫을 삼키지 않는다.
 */
function degreeEvidence(cards: readonly EvidenceCard[]): number {
  let sum = 0;
  for (const a of cards) {
    let d = 0;
    for (const b of cards) {
      if (a.assetClass !== b.assetClass || a.direction !== b.direction) continue;
      if (a.openedAt < b.closedAt && b.openedAt < a.closedAt) d++;
    }
    sum += a.info / Math.max(1, d);
  }
  return sum;
}

/**
 * 대안: 묶음의 끝을 **밀지 않는다** — 묶음 구간을 첫 카드가 정한다.
 * 첫 카드가 닫힌 뒤 열린 카드는 새 묶음을 연다. 연쇄가 멈춘다.
 */
function anchorEvidence(cards: readonly EvidenceCard[]): number {
  const sorted = [...cards].sort((a, b) => a.openedAt - b.openedAt || a.closedAt - b.closedAt);
  const open: { key: string; to: number; infos: number[] }[] = [];
  for (const card of sorted) {
    const key = `${card.assetClass}|${card.direction}`;
    const found = open.find((c) => c.key === key && card.openedAt < c.to);
    if (found) found.infos.push(card.info); // ← to를 밀지 않는다
    else open.push({ key, to: card.closedAt, infos: [card.info] });
  }
  return open.reduce((s, c) => s + c.infos.reduce((a, b) => a + b, 0) / c.infos.length, 0);
}

function evidenceOf(cards: readonly EvidenceCard[], mode: Mode): number {
  if (mode === 'ANCHOR') return anchorEvidence(cards);
  if (mode === 'DEGREE') return degreeEvidence(cards);
  if (mode === 'OVERLAP') return overlapEvidence(cards);
  return aggregateEvidence(cards, mode === 'NONE' ? 'NONE' : 'MEAN')[A];
}

const DAY = 86_400_000;
let gap = SEASON_DAYS / CARDS; // 게시 간격(일)

/**
 * **유효 장수** — 20장이 몇 장 몫의 증거로 세어지나. 난수와 무관한 구조 진단.
 * 묶음 방식은 묶음 개수, 차수 가중은 Σ 1/d_i.
 */
function effectiveCards(mode: Mode, anchorDays = H): number {
  const cards: EvidenceCard[] = [];
  for (let i = 0; i < CARDS; i++) {
    cards.push({
      assetClass: A,
      direction: 'UP',
      openedAt: Math.round(i * gap) * DAY,
      // 첫 카드만 기한이 다를 수 있다 (긴 앵커 카드 시나리오)
      closedAt: (Math.round(i * gap) + (i === 0 ? anchorDays : H)) * DAY,
      info: 1,
    });
  }
  if (mode === 'NONE') return CARDS;
  if (mode === 'DEGREE') return degreeEvidence(cards);
  if (mode === 'OVERLAP') return overlapEvidence(cards);
  const sorted = [...cards].sort((a, b) => a.openedAt - b.openedAt);
  const open: { to: number }[] = [];
  for (const card of sorted) {
    const found = open.find((c) => card.openedAt < c.to);
    if (found) {
      if (mode === 'CHAIN') found.to = Math.max(found.to, card.closedAt);
    } else open.push({ to: card.closedAt });
  }
  return open.length;
}

/** 한 시즌. 판정 순서대로 훑으며 문턱에 닿는지 본다 */
function season(pTrue: number, c: number, mode: Mode): boolean {
  const pHat = claimedProbability(P0, c);
  const z = invNcdf(1 - pTrue);
  const totalDays = Math.ceil(SEASON_DAYS + H) + 2;
  const shocks: number[] = [];
  for (let t = 0; t < totalDays; t++) shocks.push(gauss());

  const all: (EvidenceCard & { order: number })[] = [];
  for (let i = 0; i < CARDS; i++) {
    // GROUP장씩 같은 순간에 낸다 (GROUP=1이면 연속 게시)
    const a = Math.round(Math.floor(i / GROUP) * gap * GROUP);
    const b = a + H;
    let s = 0;
    for (let t = a; t < b; t++) s += shocks[t];
    const mkt = s / Math.sqrt(H);
    const x = Math.sqrt(RHO) * mkt + Math.sqrt(1 - RHO) * gauss();
    all.push({
      assetClass: A,
      direction: 'UP',
      openedAt: a * DAY,
      closedAt: b * DAY,
      info: infoOf(pHat, x > z),
      order: b,
    });
  }
  all.sort((p, q) => p.order - q.order); // 판정 순서

  const judged: EvidenceCard[] = [];
  for (const card of all) {
    judged.push(card);
    if (evidenceOf(judged, mode) <= THRESH) return true;
  }
  return false;
}

function rate(pTrue: number, c: number, mode: Mode): number {
  let hit = 0;
  for (let i = 0; i < N; i++) if (season(pTrue, c, mode)) hit++;
  return (hit / N) * 100;
}

console.log(`\n■ ${A} σ=${(SIG * 100).toFixed(0)}%/일 · 시즌 ${SEASON_DAYS}일 · p₀(30일,15%) ${(P0 * 100).toFixed(1)}%`);
console.log(`  완전겹침 상관 ρ=${RHO} · 1단 문턱 D ≤ ${THRESH} (α=5%) · n=${N}`);
console.log('  묶음 = 게시 간격 대비 기한이 길수록 크게 뭉친다 (간격 = 시즌/장수)\n');

const MODES = ['NONE', 'CHAIN', 'ANCHOR', 'DEGREE', 'OVERLAP'] as const;
const SCEN = [
  [8, 14],
  [8, 30],
  [12, 30],
  [20, 30],
  [20, 60],
  [30, 30],
  [30, 90],
  [12, 7],
] as const;

function table(title: string, cell: (m: Mode) => string): void {
  console.log(`■ ${title}`);
  console.log(`  ${'장수×기한'.padEnd(12)}${'간격'.padStart(6)}${MODES.map((m) => m.padStart(9)).join('')}`);
  for (const [cards, h] of SCEN) {
    CARDS = cards;
    H = h;
    gap = SEASON_DAYS / CARDS;
    P0 = noSkillTouchProbability('UP', MAG, A, H, SIG);
    console.log(
      `  ${`${cards}장 × ${h}일`.padEnd(12)}${gap.toFixed(1).padStart(6)}` +
        MODES.map((m) => cell(m).padStart(9)).join(''),
    );
  }
  console.log('');
}

table('① 유효 장수 — 카드가 몇 장 몫의 증거로 세어지나', (m) => effectiveCards(m).toFixed(1));
table('② 정직한 신고자의 오작동률 (목표: ≤ 5%)', (m) =>
  rate(claimedProbability(P0, 5), 5, m).toFixed(2) + '%',
);
table('③ 표적 탐지력 — 실력 없이 c=10 (높을수록 좋다)', (m) => rate(P0, 10, m).toFixed(0) + '%');
table('④ 중간 표적 — 실력 없이 c=7', (m) => rate(P0, 7, m).toFixed(0) + '%');

// ── 긴 앵커 카드 공격 ────────────────────────────────────────
// 시즌을 덮는 카드 한 장을 먼저 깔면 이후 카드가 전부 그 묶음에 빨려 든다.
console.log('■ ⑤ 긴 앵커 카드 공격 — 첫 카드만 기한 90일, 나머지 30일 (유효 장수)');
console.log(`  ${'장수'.padEnd(12)}${''.padStart(6)}${MODES.map((m) => m.padStart(9)).join('')}`);
for (const cards of [12, 20, 30]) {
  CARDS = cards;
  H = 30;
  gap = SEASON_DAYS / CARDS;
  console.log(
    `  ${`${cards}장 + 앵커`.padEnd(12)}${''.padStart(6)}` +
      MODES.map((m) => effectiveCards(m, 90).toFixed(1).padStart(9)).join(''),
  );
}
// ── 상관을 최악까지 올려 본다 ─────────────────────────────────
// 보정은 "완전히 겹치면 상관 1"을 가정한다. 진짜 ρ가 1일 때도 α 안에 있어야 한다.
console.log('■ ⑥ 상관을 올렸을 때 정직한 신고자의 오작동률 (20장 × 30일, 목표 ≤ 5%)');
console.log(`  ${'ρ'.padEnd(12)}${''.padStart(6)}${MODES.map((m) => m.padStart(9)).join('')}`);
CARDS = 20;
H = 30;
gap = SEASON_DAYS / CARDS;
P0 = noSkillTouchProbability('UP', MAG, A, H, SIG);
for (const r of [0.6, 0.8, 1.0]) {
  RHO = r;
  console.log(
    `  ${`ρ = ${r.toFixed(1)}`.padEnd(12)}${''.padStart(6)}` +
      MODES.map((m) => (rate(claimedProbability(P0, 5), 5, m).toFixed(2) + '%').padStart(9)).join(''),
  );
}
RHO = 0.6;

// ── 파도 게시 — 기존 캘리브레이션이 유지되는지 ────────────────
// simEvidenceCorrelation.ts가 재던 구조(동시에 여러 장, 파도끼리는 안 겹침).
// 새 보정이 이 자리에서 옛 보정과 같은 값을 내야 앞선 결론이 무너지지 않는다.
console.log('■ ⑦ 파도 게시 — 5장씩 동시에, 기한 14일 (파도끼리 안 겹침), ρ=1.0');
CARDS = 20;
H = 14;
GROUP = 5;
RHO = 1.0;
gap = SEASON_DAYS / CARDS;
P0 = noSkillTouchProbability('UP', MAG, A, H, SIG);
console.log(`  ${'지표'.padEnd(12)}${''.padStart(6)}${MODES.map((m) => m.padStart(9)).join('')}`);
console.log(
  `  ${'오작동'.padEnd(12)}${''.padStart(6)}` +
    MODES.map((m) => (rate(claimedProbability(P0, 5), 5, m).toFixed(2) + '%').padStart(9)).join(''),
);
console.log(
  `  ${'c=10 탐지'.padEnd(12)}${''.padStart(6)}` +
    MODES.map((m) => (rate(P0, 10, m).toFixed(0) + '%').padStart(9)).join(''),
);
GROUP = 1;
RHO = 0.6;

console.log('\n  NONE 보정없음 · CHAIN 현행(묶음 끝을 민다) · ANCHOR 첫 카드가 끝을 정한다');
console.log('  DEGREE 겹치면 한 장으로 세어 나눈다 · OVERLAP 겹친 비율만큼만 나눈다\n');
