// 등급 임계값 재캘리브레이션 (점수 v3) — npx tsx scripts/simTierThresholds.ts
//
// 목표 피라미드 (2026-08-05 확정): 무표기 100% / 시니어 상위 50% / 마스터 상위 25% /
// 펠로우 상위 10% / 인투빌 펠로우 ~1% (상대평가·심사 — 개별 임계값 없음, MVP 제외 유지)
//
// 근거:
//  · 시니어 50% — "준수한 리서처 절반이 첫 시즌 도달" 공급 유지 원칙 그대로.
//    콜드스타트에서 승급 경험이 이탈 방지의 핵심이고, 시니어 특권은 수수료 인하뿐이라
//    수익성 비용이 가장 작다
//  · 마스터 25% — 선결제(10%) 해금 경계. 구매자 무위험 진입(100% 성과 연동) 커버리지를
//    전체 리서처의 75%로 유지하면서, 등급 칩(틴트)의 희소성을 지킨다.
//    50→25→10→1의 "절반 사다리"라 단계 감각이 학습하기 쉽다
//  · 펠로우 10% — 구독(2단계 매출) 공급자를 열 명 중 한 명으로: 초기 30~50명 기준
//    3~5명이 구독을 열 수 있어 2단계 매출 개시가 늦어지지 않는다. 솔리드 칩 희소성 유지
//  · 인투빌 펠로우 ~1% — 점수 임계값이 아니라 심사·정원제(브랜드 규정: 연 5~10명).
//    콜드스타트 인원(30~50명)에서 %컷은 0~1명이라 통계적으로 무의미 → 상대평가 유지
//
// 모집단 가정 (콜드스타트 — 직접 영입으로 큐레이션된 공급, §5 1단계):
//  정밀형 5% / 우수 방향형 25% / 준수형 50% / 하위형 15% / 스팸 5%
// 시즌 카드 수: 기본 20장 (활성 5슬롯 × 분기 회전 ~4회), 민감도 12·30장.

import {
  computeDirectionScore,
  computeStabilityScore,
  MIN_MAGNITUDE_PCT,
} from '../src/domain/scoring';

const FLOOR = MIN_MAGNITUDE_PCT.CRYPTO;
const RESEARCHERS = 20_000;

interface Persona {
  name: string;
  mu: number;
  sigma: number;
  weight: number;
  c?: number;
  s?: number;
  claim?: number;
}
const personas: Persona[] = [
  { name: '정밀형', mu: 15, sigma: 6, weight: 0.05 },
  { name: '우수 방향형', mu: 12, sigma: 12, weight: 0.25 },
  { name: '준수형', mu: 8, sigma: 14, weight: 0.5 },
  { name: '하위형', mu: 3, sigma: 14, weight: 0.15 },
  { name: '스팸', mu: 0, sigma: 12, weight: 0.05 },
];

function randn(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function cardScore(p: Persona, x: number): number {
  if (x === 0) return 0;
  return (
    computeDirectionScore('UP', p.claim!, p.c!, x).score +
    computeStabilityScore('UP', p.claim!, p.s!, x, FLOOR).score
  );
}

// 유형별 정직 최적 c·s (몬테카를로 argmax)
for (const p of personas) {
  p.claim = Math.max(p.mu, FLOOR);
  const draws = Array.from({ length: 40_000 }, () => p.mu + p.sigma * randn());
  let best = { c: 1, s: 1, ev: -Infinity };
  for (let c = 1; c <= 10; c++) {
    for (let s = 1; s <= 10; s++) {
      let sum = 0;
      for (const x of draws) {
        if (x === 0) continue;
        sum +=
          computeDirectionScore('UP', p.claim, c, x).score +
          computeStabilityScore('UP', p.claim, s, x, FLOOR).score;
      }
      const ev = sum / draws.length;
      if (ev > best.ev) best = { c, s, ev };
    }
  }
  p.c = best.c;
  p.s = best.s;
  console.log(`유형 ${p.name}: claim ${p.claim} c*=${p.c} s*=${p.s} (카드당 EV ${best.ev.toFixed(1)})`);
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

for (const cards of [12, 20, 30]) {
  const seasons: number[] = [];
  const byPersona = new Map<string, number[]>();
  for (let i = 0; i < RESEARCHERS; i++) {
    let r = Math.random();
    let p = personas[personas.length - 1];
    for (const q of personas) {
      if (r < q.weight) {
        p = q;
        break;
      }
      r -= q.weight;
    }
    let total = 0;
    for (let k = 0; k < cards; k++) total += cardScore(p, p.mu + p.sigma * randn());
    seasons.push(total);
    if (!byPersona.has(p.name)) byPersona.set(p.name, []);
    byPersona.get(p.name)!.push(total);
  }
  seasons.sort((a, b) => a - b);
  const top = (pct: number) => Math.round(quantile(seasons, 1 - pct));
  console.log(
    `\n■ 시즌 ${cards}장: 상위 50% 경계 ${top(0.5).toLocaleString()} | 상위 25% ${top(0.25).toLocaleString()} | 상위 10% ${top(0.1).toLocaleString()} | 상위 1% ${top(0.01).toLocaleString()}`,
  );
}

// 제안 임계값 검증 (20장 기준 라운딩 후): 실제 도달률과 준수형 시니어 도달률
const PROPOSED = { SILVER: 300, GOLD: 900, PLATINUM: 2_400 };
{
  const cards = 20;
  const seasons: { name: string; total: number }[] = [];
  for (let i = 0; i < RESEARCHERS; i++) {
    let r = Math.random();
    let p = personas[personas.length - 1];
    for (const q of personas) {
      if (r < q.weight) {
        p = q;
        break;
      }
      r -= q.weight;
    }
    let total = 0;
    for (let k = 0; k < cards; k++) total += cardScore(p, p.mu + p.sigma * randn());
    seasons.push({ name: p.name, total });
  }
  const share = (t: number) => seasons.filter((s) => s.total >= t).length / seasons.length;
  const decent = seasons.filter((s) => s.name === '준수형');
  const decentSilver = decent.filter((s) => s.total >= PROPOSED.SILVER).length / decent.length;
  console.log(
    `\n■ 제안 임계값 검증 (20장): 시니어 ${PROPOSED.SILVER} → 도달 ${(share(PROPOSED.SILVER) * 100).toFixed(1)}% | ` +
      `마스터 ${PROPOSED.GOLD} → ${(share(PROPOSED.GOLD) * 100).toFixed(1)}% | ` +
      `펠로우 ${PROPOSED.PLATINUM} → ${(share(PROPOSED.PLATINUM) * 100).toFixed(1)}%`,
  );
  console.log(`   준수형의 첫 시즌 시니어 도달률: ${(decentSilver * 100).toFixed(1)}% (목표 ≈ 50%)`);
}
