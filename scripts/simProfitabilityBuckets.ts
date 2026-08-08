// 수익성 5구간 경계 결정 — npx tsx scripts/simProfitabilityBuckets.ts
//
// 수익성 = 리서처가 신고한 예측 크기 M을 자산군 크기 하한 F의 배수로 정규화해
// 5단계로 구간화한 표시 지표 (구매 전 목표 수익률 원값을 가리는 마스킹의 대체물).
//
// 결정 기준:
//  C1 변별력: 현실적인 신고 크기 분포에서 5구간이 고르게 쓰일 것 (한 구간 쏠림 방지)
//  C2 스팸 억제: 무실력자가 높은 구간 라벨을 "입어보는" 비용이 구간이 오를수록
//     가파르게 커질 것 — v3에서 신고 크기 M은 곧 방향 성분의 판돈(방향 반대 = −M)이라
//     라벨 사칭이 스스로 파멸적인지 정량 확인
//  C3 단타 격리: 하한 근처 소형 신고(단타·스팸의 서식지)가 최하 구간에 격리되고,
//     실력 없이 상위 구간에 도달하는 경로가 기대 점수상 막혀 있을 것
//  C4 역산 방지: 각 구간 폭이 주식 2.5%p / 코인 5%p 이상 — 라벨에서 원값 복원 불가
//
// 경계는 F 배수로 정의 — 주식(F=5%)과 코인(F=10%)에서 "얼마나 공격적인 베팅인가"가
// 같은 축에 놓인다. 후보는 모두 마지막 경계가 다른 등비형 사다리다.

import {
  computeDirectionScore,
  computeStabilityScore,
  MIN_MAGNITUDE_PCT,
} from '../src/domain/scoring';

const DRAWS = 120_000;

function randn(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── 후보 경계 (F 배수, [b1,b2,b3,b4] → 5구간) ─────────────────────
const CANDIDATES: Record<string, number[]> = {
  'A 촘촘(√2 등비): 1.4/2/2.8/4': [1.4, 2, 2.8, 4],
  'B 라운드: 1.5/2/3/5': [1.5, 2, 3, 5],
  'C 넓게: 1.5/2.5/4/6': [1.5, 2.5, 4, 6],
};

function bucketOf(multiple: number, bounds: number[]): number {
  let lv = 1;
  for (const b of bounds) if (multiple >= b) lv++;
  return lv;
}

// ── C1 변별력: 신고 크기 분포 가정 ────────────────────────────────
// 신고 크기는 하한에 붙는 경향(단타·보수 신고)이 강하고 큰 신고일수록 드물다 —
// L = M/F ~ LogNormal(median 1.6, σ=0.55)를 1.0에서 절단. 운영 데이터로 교체 예정.
const claims = Array.from({ length: 50_000 }, () =>
  Math.max(1, Math.exp(Math.log(1.6) + 0.55 * randn())),
);

console.log('■ C1 변별력 — 신고 분포(중앙값 1.6×F) 기준 구간 점유율 (%)');
for (const [name, bounds] of Object.entries(CANDIDATES)) {
  const occ = [0, 0, 0, 0, 0];
  for (const l of claims) occ[bucketOf(l, bounds) - 1]++;
  console.log(
    `   ${name.padEnd(28)} ${occ.map((n) => ((n / claims.length) * 100).toFixed(0).padStart(3)).join(' | ')}`,
  );
}

// ── C2·C3 스팸·단타 비용: v3 기대 점수 (카드당) ────────────────────
// 무실력: 실제 움직임 X ~ N(0, σ). 단타: 초단기라 실제 변동이 작다 (σ = 0.6F).
// 실력자 대조군: 신고 크기만큼의 우위가 실제로 있는 사람 (μ = 0.8M, σ = 0.9M).
// c=1, s=1(불참)로 최소 배팅 — "라벨만 입어보는" 가장 싼 전략의 비용을 잰다.
function evPerCard(claim: number, mu: number, sigma: number, floor: number): number {
  let sum = 0;
  for (let i = 0; i < DRAWS; i++) {
    const x = mu + sigma * randn();
    if (x === 0) continue;
    sum +=
      computeDirectionScore('UP', claim, 1, x).score +
      computeStabilityScore('UP', claim, 1, x, floor).score;
  }
  return sum / DRAWS;
}

console.log('\n■ C2·C3 — 구간별 "라벨을 입는 비용" (경계 B 기준, 카드당 v3 기대 점수, c=1·s=1)');
console.log('   구간 진입 크기 | 무실력(σ=1.2F) | 단타(실변동 0.6F) | 실력자(우위=신고 크기)');
const B = CANDIDATES['B 라운드: 1.5/2/3/5'];
for (const [assetLabel, F] of [
  ['주식(F=5%)', MIN_MAGNITUDE_PCT.KR_EQUITY],
  ['코인(F=10%)', MIN_MAGNITUDE_PCT.CRYPTO],
] as const) {
  console.log(`   — ${assetLabel}`);
  const entries = [1, ...B]; // 각 구간의 최저 진입 크기 = 가장 싼 사칭 지점
  entries.forEach((mult, i) => {
    const M = mult * F;
    const noSkill = evPerCard(M, 0, 1.2 * F, F);
    const scalper = evPerCard(M, 0.3 * F, 0.6 * F, F);
    const skilled = evPerCard(M, 0.8 * M, 0.9 * M, F);
    console.log(
      `   LV${i + 1} (${String(M).padStart(4)}%) | ${noSkill.toFixed(0).padStart(6)} | ${scalper.toFixed(0).padStart(6)} | ${skilled.toFixed(0).padStart(6)}`,
    );
  });
}

// ── C4 역산 방지 — 구간 폭 (%p) ───────────────────────────────────
console.log('\n■ C4 — 경계 B의 구간 폭: 라벨에서 원값을 복원할 수 없는가');
for (const [assetLabel, F] of [
  ['주식', 5],
  ['코인', 10],
] as const) {
  const edges = [1, ...B].map((m) => m * F);
  const widths = edges.slice(0, -1).map((e, i) => `${edges[i + 1] - e}%p`);
  console.log(`   ${assetLabel}: ${widths.join(' / ')} / 개방형`);
}
