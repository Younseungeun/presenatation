// 등급 임계값 캘리브레이션 — 점수 v4(공정배당 이항) 기준. npx tsx scripts/simTierThresholds.ts
//
// 목표 피라미드 "절반 사다리" (2026-08-05 확정 유지): 시즌 종료 시
//   시니어 상위 ~50% / 마스터 ~25% / 펠로우 ~10% (인투빌 펠로우는 심사·상대평가)
//
// 방법:
//  · 기준 트랙 = 국내주식 (σ̄ 2%/일, 하한 5%, 시즌 20장, 기간 30일 카드)
//  · 모집단 (콜드스타트 큐레이션 가정, v3 캘리브레이션과 동일 구성):
//      정밀 5% / 우수 25% / 준수 50% / 하위 15% / 스팸 5%
//    실력 = 일 드리프트 k·σ. v3의 실현수익 분포 대신 GBM 우위로 표현한다
//  · 행동 가정: 학습 평형 — 각자 자기 실력에서 EV 최대인 (목표 크기 M, 신뢰도 c)를 쓴다
//    (v3 캘리브레이션의 "정직 신고" 가정의 v4 대응물 — v4는 정직 신고가 곧 EV 최대다)
//  · 카드 결과는 실력 반영 도달 확률 p(M; k)의 베르누이, 점수는 **정산이 쓰는
//    scoreJudgedCard 그대로**
//
// 이 스크립트는 동시에 p₀ 닫힌꼴의 몬테카를로 검증을 포함한다 (모델 신뢰의 전제).

import { scoreJudgedCard, DAILY_SIGMA, noSkillTouchProbability } from '../src/domain/scoring';

const SIGMA = DAILY_SIGMA.KR_EQUITY;
const FLOOR = 5;
const H = 30;
const CARDS_PER_SEASON = 20;
const N_RESEARCHERS = 20_000;

interface Cohort {
  name: string;
  k: number; // 일 드리프트 = k·σ
  weight: number;
}
const COHORTS: Cohort[] = [
  { name: '정밀형', k: 0.5, weight: 0.05 },
  { name: '우수형', k: 0.35, weight: 0.25 },
  { name: '준수형', k: 0.2, weight: 0.5 },
  { name: '하위형', k: 0.08, weight: 0.15 },
  { name: '스팸', k: 0, weight: 0.05 },
];

const M_GRID = [5, 7.5, 10, 15, 20, 25, 30, 40];
const C_GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

let seed = 424242;
function rand(): number {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 0xffffffff;
}
function gauss(): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** 표준정규 CDF — scoring.ts와 동일 근사 (여기서는 검증·실력 확률용) */
function ncdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** 실력 k 반영 도달 확률 (일봉 관측, BGK 보정 — scoring의 p₀와 같은 유도, 드리프트만 추가) */
function touchProb(mPct: number, k: number): number {
  const a = Math.log(1 + mPct / 100) + 0.5826 * SIGMA;
  const nu = k * SIGMA - 0.5 * SIGMA * SIGMA;
  const s = SIGMA * Math.sqrt(H);
  const p = 1 - ncdf((a - nu * H) / s) + Math.exp((2 * nu * a) / (SIGMA * SIGMA)) * (1 - ncdf((a + nu * H) / s));
  return Math.min(0.999, Math.max(0.0005, p));
}

/** 몬테카를로 대조 — 닫힌꼴 오차 검증 */
function mcTouch(mPct: number, k: number, n = 30_000): number {
  const target = 1 + mPct / 100;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    let sVal = 1;
    for (let t = 0; t < H; t++) {
      sVal *= Math.exp(k * SIGMA - 0.5 * SIGMA * SIGMA + SIGMA * gauss());
      if (sVal >= target) { hits++; break; }
    }
  }
  return hits / n;
}

function cardScore(M: number, c: number, hit: boolean): number {
  return scoreJudgedCard({
    direction: 'UP', targetType: 'RETURN_PCT', targetValue: M,
    confidence: c, assetClass: 'KR_EQUITY', sigmaDaily: null,
    basePrice: 100, settledPrice: hit ? 100 * (1 + M / 100) : 100,
    horizonDays: H, outcome: hit ? 'HIT' : 'MISS',
  }).score;
}

// ── ① p₀ 닫힌꼴 vs 몬테카를로 ─────────────────────────────────────
console.log('■ p₀ 닫힌꼴 검증 (국내주식 σ2%/30일, MC 30,000경로)');
console.log('   M      닫힌꼴   MC      |오차|');
for (const m of [5, 10, 15, 25]) {
  const cf = noSkillTouchProbability('UP', m, 'KR_EQUITY', H);
  const mc = mcTouch(m, 0);
  console.log(`   ${String(m).padEnd(4)} ${(cf * 100).toFixed(1).padStart(6)}% ${(mc * 100).toFixed(1).padStart(6)}%  ${(Math.abs(cf - mc) * 100).toFixed(2)}%p`);
}
console.log('   (실력 드리프트 포함 대조: k=0.25σ, M=10)');
{
  const cf = touchProb(10, 0.25);
  const mc = mcTouch(10, 0.25);
  console.log(`   →    ${(cf * 100).toFixed(1).padStart(6)}% ${(mc * 100).toFixed(1).padStart(6)}%  ${(Math.abs(cf - mc) * 100).toFixed(2)}%p`);
}

// ── ② 각 실력의 EV 최적 전략 ──────────────────────────────────────
interface Strategy { M: number; c: number; p: number; ev: number }
function bestStrategy(k: number): Strategy {
  let best: Strategy = { M: FLOOR, c: 1, p: touchProb(FLOOR, k), ev: -Infinity };
  for (const M of M_GRID) {
    const p = touchProb(M, k);
    for (const c of C_GRID) {
      const ev = p * cardScore(M, c, true) + (1 - p) * cardScore(M, c, false);
      if (ev > best.ev) best = { M, c, p, ev };
    }
  }
  return best;
}

console.log('\n■ 실력별 EV 최적 전략 (학습 평형 가정)');
const strategies = new Map<string, Strategy>();
for (const co of COHORTS) {
  const s = bestStrategy(co.k);
  strategies.set(co.name, s);
  console.log(`   ${co.name.padEnd(4)} k=${co.k}σ → M=${s.M}% c=${s.c} (적중률 ${(s.p * 100).toFixed(0)}%) EV ${s.ev.toFixed(0)}점/장`);
}

// ── ③ 시즌 점수 분포 → 임계값 ────────────────────────────────────
function seasonTotals(cards: number): { name: string; total: number }[] {
  const rows: { name: string; total: number }[] = [];
  for (const co of COHORTS) {
    const s = strategies.get(co.name)!;
    const n = Math.round(N_RESEARCHERS * co.weight);
    for (let i = 0; i < n; i++) {
      let total = 0;
      for (let cIdx = 0; cIdx < cards; cIdx++) {
        total += cardScore(s.M, s.c, rand() < s.p);
      }
      rows.push({ name: co.name, total });
    }
  }
  return rows.sort((a, b) => b.total - a.total);
}

const rows = seasonTotals(CARDS_PER_SEASON);
const pct = (q: number) => rows[Math.floor(rows.length * q)].total;
console.log(`\n■ 시즌 ${CARDS_PER_SEASON}장 점수 분포 (${rows.length.toLocaleString()}명)`);
console.log(`   상위 50% 경계 ${pct(0.5).toFixed(0)} / 25% ${pct(0.25).toFixed(0)} / 10% ${pct(0.1).toFixed(0)}`);

// 라운딩 제안
function roundNice(x: number): number {
  const mag = x >= 2000 ? 500 : x >= 500 ? 100 : 50;
  return Math.round(x / mag) * mag;
}
const proposal = { SILVER: roundNice(pct(0.5)), GOLD: roundNice(pct(0.25)), PLATINUM: roundNice(pct(0.1)) };
console.log(`   제안 임계값: 시니어 ${proposal.SILVER} / 마스터 ${proposal.GOLD} / 펠로우 ${proposal.PLATINUM}`);

// 검증: 제안값 적용 시 실제 도달률·준수형 시니어 도달률
for (const cards of [12, 20, 30]) {
  const rs = seasonTotals(cards);
  const reach = (t: number) => rs.filter((r) => r.total >= t).length / rs.length;
  const decent = rs.filter((r) => r.name === '준수형');
  const decentSilver = decent.filter((r) => r.total >= proposal.SILVER).length / decent.length;
  const spam = rs.filter((r) => r.name === '스팸');
  const spamAvg = spam.reduce((a, r) => a + r.total, 0) / spam.length;
  console.log(
    `   시즌 ${String(cards).padStart(2)}장: 시니어 ${(reach(proposal.SILVER) * 100).toFixed(1)}% / 마스터 ${(reach(proposal.GOLD) * 100).toFixed(1)}% / 펠로우 ${(reach(proposal.PLATINUM) * 100).toFixed(1)}%  · 준수형 시니어 도달 ${(decentSilver * 100).toFixed(0)}% · 스팸 평균 ${spamAvg.toFixed(0)}점`,
  );
}
