import {
  claimedProbability,
  DAILY_SIGMA,
  noSkillTouchProbability,
} from '../src/domain/scoring';
import { CORRELATION_CORRECTION, clusterEvidence, type EvidenceCard } from '../src/domain/evidence';

// 규율 증거의 상관 보정 검증 — npx tsx scripts/simEvidenceCorrelation.ts
//
// ── 문제 ──────────────────────────────────────────────────────
// 규율 통계량 D는 카드별 **주변** 로그우도비의 합이다.
//
//     D = Σ ln( L_i(신고) / L_i(무정보) )
//
// Ville 부등식 P(∃t: D ≤ −ln(1/α)) ≤ α 는 1/Λ가 평균 1의 마팅게일일 때 성립하는데,
// 그러려면 각 항이 **이전까지 드러난 결과를 알고 낸 조건부 신고**여야 한다.
// 같은 기간에 열려 있는 상관된 카드들은 그 조건을 깬다: 반도체 3종목에 같은 방향
// 카드를 걸면 셋이 함께 맞고 함께 틀리는데, 합은 세 번의 독립 증거로 센다.
//
// 완전 상관 3장 묶음의 E_P[1/Λ] = 1.75 (손계산) — 부등식의 전제 자체가 사라진다.
//
// ── 후보 보정 ─────────────────────────────────────────────────
//   NONE         보정 없음 (현행)
//   MEAN         묶음의 **평균**을 한 항으로 (최악 가정 ρ=1의 설계효과)
//   FIRST        묶음에서 **먼저 게시된 한 장만** 세고 나머지는 버린다
//
// 재는 것: ① 정직한 사람의 오작동률이 α 이내로 돌아오는가 ② 표적 탐지력을
// 얼마나 잃는가. ①이 안 되면 그 보정은 쓸 수 없고, ②는 그 대가다.

const A = 'KR_EQUITY' as const;
const SIG = DAILY_SIGMA[A];
const H = 30;
const CARDS = 20;
const N = 60_000;
const M = 15;

const P0 = noSkillTouchProbability('UP', M, A, H, SIG);

// ── 난수 (mulberry32 + Box–Muller) ────────────────────────────
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
      t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
/** ncdf의 역함수 — 이분법으로 충분하다(호출 횟수가 적다) */
function invNcdf(p: number): number {
  let lo = -8, hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ncdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const infoOf = (pHat: number, hit: boolean) =>
  hit ? Math.log(pHat / P0) : Math.log((1 - pHat) / (1 - P0));

/**
 * 한 시즌을 굴린다.
 * @param pTrue 실제 적중 확률 (정직한 사람은 pHat과 같다)
 * @param c 신고 신뢰도
 * @param group 동시에 여는 카드 묶음 크기
 * @param rho 묶음 안의 상관 (가우시안 코퓰러)
 * @param mode 보정 방식
 * @returns 시즌 중 한 번이라도 1단 문턱(−3.00)에 닿았는가
 */
function season(
  pTrue: number,
  c: number,
  group: number,
  rho: number,
  mode: 'NONE' | 'MEAN' | 'FIRST',
): boolean {
  const pHat = claimedProbability(P0, c);
  const z = invNcdf(1 - pTrue); // 적중 = 잠재변수 > z
  const cards: EvidenceCard[] = [];
  const waves = Math.floor(CARDS / group);
  for (let wv = 0; wv < waves; wv++) {
    const common = gauss();
    for (let i = 0; i < group; i++) {
      const x = Math.sqrt(rho) * common + Math.sqrt(1 - rho) * gauss();
      cards.push({
        assetClass: A,
        direction: 'UP',
        // 같은 파도의 카드는 기간이 겹친다(동시에 열려 있다)
        openedAt: wv * 1000,
        closedAt: wv * 1000 + 500,
        info: infoOf(pHat, x > z),
      });
      // 파도 단위로 문턱을 확인한다 — 시즌 중 언제라도 닿으면 발동이다
    }
    const d = clusterEvidence(cards, mode)[A];
    if (d <= -3.0) return true;
  }
  return false;
}

function rate(
  pTrue: number,
  c: number,
  group: number,
  rho: number,
  mode: 'NONE' | 'MEAN' | 'FIRST',
): number {
  let hit = 0;
  for (let i = 0; i < N; i++) if (season(pTrue, c, group, rho, mode)) hit++;
  return (hit / N) * 100;
}

console.log(`\n■ ${A} σ=${(SIG * 100).toFixed(0)}%/일 · ${H}일 · 크기 ${M}% · p₀ ${(P0 * 100).toFixed(1)}% · 시즌 ${CARDS}장 · n=${N}`);
console.log(`  1단 문턱 D ≤ −3.00 (α = 5%)\n`);

console.log('■ ① 정직한 신고자의 오작동률 (목표: ≤ 5%)');
console.log(`  ${'묶음×상관'.padEnd(14)}${'보정없음'.padStart(10)}${'평균'.padStart(10)}${'대표1장'.padStart(10)}`);
for (const [group, rho] of [[1, 0], [2, 0.6], [3, 0.6], [3, 1], [5, 0.6], [5, 1]] as const) {
  const cells = (['NONE', 'MEAN', 'FIRST'] as const).map((m) =>
    (rate(claimedProbability(P0, 5), 5, group, rho, m).toFixed(2) + '%').padStart(10),
  );
  console.log(`  ${`${group}장 × ρ${rho}`.padEnd(14)}${cells.join('')}`);
}

console.log('\n■ ② 표적 탐지력 — 실력 없이 c=10을 부르는 사람이 걸리는 비율 (높을수록 좋다)');
console.log(`  ${'묶음×상관'.padEnd(14)}${'보정없음'.padStart(10)}${'평균'.padStart(10)}${'대표1장'.padStart(10)}`);
for (const [group, rho] of [[1, 0], [3, 0.6], [5, 0.6]] as const) {
  const cells = (['NONE', 'MEAN', 'FIRST'] as const).map((m) =>
    (rate(P0, 10, group, rho, m).toFixed(1) + '%').padStart(10),
  );
  console.log(`  ${`${group}장 × ρ${rho}`.padEnd(14)}${cells.join('')}`);
}

console.log(`\n  (도메인 채택값: ${CORRELATION_CORRECTION})\n`);
