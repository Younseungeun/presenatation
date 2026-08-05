// 점수 모델 v3 (거리 기반 연속 모델) 종합 검증 — npx tsx scripts/simScoreModel.ts
//
// 검증 항목:
//  1) 크기 정직성: 예측 크기를 자기 믿음(중앙값)대로 신고하는 것이 최적인가 (λ* ≈ 1)
//  2) 신뢰도 정직성: 실력이 좋을수록 최적 c가 단조 증가하는가
//  3) 안정성 정직성: 정밀할수록 최적 s가 커지고, 정밀도 없으면 s*=1(불참)인가
//  4) 악용 시나리오: 샌드배깅·과장·블러핑이 정직 전략보다 손해인가
//  5) 스케일: 구모델(적중비율+100컷) 대비 시즌 점수 배율 → 등급 임계값·규율 래더 가이드
//
// 실현 모델: 리서처가 고른 종목의 실제 움직임 X ~ N(μ, σ) [%p], 상승 예측 가정.
// 자산군은 CRYPTO(크기 하한·정규화 바닥 10%p) 기준.

import {
  computeDirectionScore,
  computeStabilityScore,
  lossAmplifier,
  MIN_MAGNITUDE_PCT,
  winAmplifier,
} from '../src/domain/scoring';

const FLOOR = MIN_MAGNITUDE_PCT.CRYPTO; // 10
const CARDS = 40;
const DRAWS = 60_000;

interface Persona {
  name: string;
  mu: number;
  sigma: number;
  draws?: number[];
}
const personas: Persona[] = [
  { name: '정밀형', mu: 15, sigma: 6 },
  { name: '우수 방향형', mu: 12, sigma: 12 },
  { name: '준수형', mu: 8, sigma: 14 },
  { name: '스팸(무정보)', mu: 0, sigma: 12 },
];

function randn(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
for (const p of personas) {
  p.draws = Array.from({ length: DRAWS }, () => p.mu + p.sigma * randn());
}

/** v3 카드 점수 (상승 예측, 실현 x) */
function v3Score(claim: number, c: number, s: number, x: number): number {
  if (x === 0) return 0;
  return (
    computeDirectionScore('UP', claim, c, x).score +
    computeStabilityScore('UP', claim, s, x, FLOOR).score
  );
}

/** 구모델(적중 비율 + 100컷, 방향 전용) — 임계값 스케일 비교용 */
function oldScore(claim: number, c: number, x: number): number {
  if (x === 0) return 0;
  const base = Math.min((Math.abs(x) / claim) * 100, 100);
  return x > 0 ? base * winAmplifier(c) : -base * lossAmplifier(c);
}

function evOf(p: Persona, fn: (x: number) => number): number {
  let sum = 0;
  for (const x of p.draws!) sum += fn(x);
  return sum / p.draws!.length;
}

/** 주어진 claim에서 (c, s) 최적 조합과 EV */
function bestCS(p: Persona, claim: number): { c: number; s: number; ev: number } {
  let best = { c: 1, s: 1, ev: -Infinity };
  for (let c = 1; c <= 10; c++) {
    for (let s = 1; s <= 10; s++) {
      const ev = evOf(p, (x) => v3Score(claim, c, s, x));
      if (ev > best.ev) best = { c, s, ev };
    }
  }
  return best;
}

// ── 1) 크기 정직성 ─────────────────────────────────────────────────
console.log('■ 1) 크기 정직성 — 믿음 중앙값 μ 대비 신고 배수 λ의 최적값 (c·s는 각 λ에서 최적 선택)');
for (const p of personas.filter((q) => q.mu > 0)) {
  let bestLambda = 0;
  let bestEv = -Infinity;
  const rows: string[] = [];
  for (let lambda = 0.4; lambda <= 2.001; lambda += 0.2) {
    const claim = Math.max(p.mu * lambda, FLOOR);
    const { ev } = bestCS(p, claim);
    rows.push(`λ${lambda.toFixed(1)}:${Math.round(ev)}`);
    if (ev > bestEv) {
      bestEv = ev;
      bestLambda = lambda;
    }
  }
  console.log(`   ${p.name} (μ=${p.mu}): λ*=${bestLambda.toFixed(1)} | 카드당 EV: ${rows.join(' ')}`);
}

// ── 2·3) 신뢰도·안정성 정직성 ──────────────────────────────────────
console.log('\n■ 2·3) 정직 신고 시(λ=1, 하한 준수) 최적 c·s — 실력·정밀도에 단조인가');
const honest: Record<string, { claim: number; c: number; s: number; ev: number }> = {};
for (const p of personas) {
  const claim = Math.max(p.mu, FLOOR);
  const b = bestCS(p, claim);
  honest[p.name] = { claim, ...b };
  console.log(
    `   ${p.name.padEnd(10)} claim ${claim} | c*=${b.c} s*=${b.s} | 카드당 EV ${b.ev.toFixed(1)} | 시즌(40장) ${Math.round(b.ev * CARDS).toLocaleString()}`,
  );
}

// ── 4) 악용 시나리오 ───────────────────────────────────────────────
console.log('\n■ 4) 악용 시나리오 — 정직 전략 대비 시즌 점수 (음수 폭이 클수록 방어가 강함)');
{
  const prec = personas[0]; // 정밀형이 샌드배깅 시도
  const sandbag = bestCS(prec, FLOOR); // 크기 하한으로 과소 신고 (최적 c·s 허용)
  console.log(
    `   샌드배깅(정밀형이 크기 ${FLOOR} 신고): 시즌 ${Math.round(sandbag.ev * CARDS).toLocaleString()} vs 정직 ${Math.round(honest['정밀형'].ev * CARDS).toLocaleString()}`,
  );
  const decent = personas[2]; // 준수형이 과장
  const overclaim = bestCS(decent, decent.mu * 2.5);
  console.log(
    `   과장(준수형이 크기 2.5배 신고): 시즌 ${Math.round(overclaim.ev * CARDS).toLocaleString()} vs 정직 ${Math.round(honest['준수형'].ev * CARDS).toLocaleString()}`,
  );
  for (const p of personas) {
    const h = honest[p.name];
    const bluffC = evOf(p, (x) => v3Score(h.claim, 10, h.s, x));
    const bluffS = evOf(p, (x) => v3Score(h.claim, h.c, 8, x));
    console.log(
      `   ${p.name.padEnd(10)} c=10 블러핑 ${Math.round(bluffC * CARDS).toLocaleString()} | s=8 블러핑 ${Math.round(bluffS * CARDS).toLocaleString()} | 정직 ${Math.round(h.ev * CARDS).toLocaleString()}`,
    );
  }
}

// ── 5) 스케일 비교 → 임계값 가이드 ─────────────────────────────────
console.log('\n■ 5) 구모델 대비 시즌 점수 스케일 (같은 draws, 각 모델에서 최적 전략)');
for (const p of personas) {
  const h = honest[p.name];
  // 구모델 최적 c
  let oldBest = { c: 1, ev: -Infinity };
  for (let c = 1; c <= 10; c++) {
    const ev = evOf(p, (x) => oldScore(h.claim, c, x));
    if (ev > oldBest.ev) oldBest = { c, ev };
  }
  const ratio = oldBest.ev > 0 ? (h.ev / oldBest.ev).toFixed(2) : '—';
  console.log(
    `   ${p.name.padEnd(10)} 구모델(c*=${oldBest.c}) 시즌 ${Math.round(oldBest.ev * CARDS).toLocaleString()} → v3 시즌 ${Math.round(h.ev * CARDS).toLocaleString()} (배율 ${ratio})`,
  );
}

// 규율 래더: 스팸이 정지(−10,000)까지 걸리는 카드 수
{
  const spam = personas[3];
  const h = honest[spam.name];
  const evNew = h.ev; // 스팸의 "최선" 전략 (그나마 손실 최소)
  let oldBest = -Infinity;
  for (let c = 1; c <= 10; c++) oldBest = Math.max(oldBest, evOf(spam, (x) => oldScore(FLOOR, c, x)));
  const cardsToStop = (ev: number) => (ev < 0 ? Math.ceil(10_000 / -ev) : Infinity);
  console.log(
    `\n■ 규율 래더: 스팸 최선 전략의 카드당 EV — 구모델 ${oldBest.toFixed(1)} (정지까지 ${cardsToStop(oldBest)}장) → v3 ${evNew.toFixed(1)} (정지까지 ${cardsToStop(evNew)}장)`,
  );
}
