// 도달 판정 하에서의 리서처 유인 실측 — npx tsx scripts/simTouchIncentives.ts
//
// 걱정 (2026-08-10 사용자 제기): 판정이 "기한 내 종가 도달"로 통합되면
//  ① 적중 시 판정가 = 목표가 → 오차 ε ≡ 0 → 안정성이 항상 만점 → 신뢰도와 중첩
//  ② 낮은 목표(하한 근처)로 적중률만 노리는 전략이 유리해질 수 있다
//
// 이 시뮬은 **정산이 쓰는 실제 함수(scoreJudgedCard)** 로 유인을 잰다 — 공식을 옮겨
// 적으면 언젠가 갈라진다. 판정 규칙도 실제와 동일: 어느 날 종가가 목표 이상이면 적중
// (판정가=목표가), 아니면 실패(판정가=기한 종가).
//
// 역사적 기록: v3에서 위 두 결함을 실측해 v4 재설계의 근거가 된 스크립트다.
// 지금은 scoreJudgedCard가 v4(공정배당 이항)라 "현행" = v4 검증으로 읽는다 —
// 안정성 몫 0%·스팸 EV ≈ 0·최적 M이 실력 따라 커지는 것이 v4가 고친 결과다.

import { scoreJudgedCard } from '../src/domain/scoring';
import { PROFITABILITY_BASE_PCT } from '../src/domain/scoring';

interface Market {
  label: string;
  assetClass: 'KR_EQUITY' | 'CRYPTO';
  sigma: number;
  H: number;
}
const MARKETS: Market[] = [
  { label: '주식(σ2%/30일)', assetClass: 'KR_EQUITY', sigma: 0.02, H: 30 },
  { label: '코인(σ4%/30일)', assetClass: 'CRYPTO', sigma: 0.04, H: 30 },
];
// 실력 = 일 드리프트 (σ 대비). 0 = 무정보 스팸, 0.25σ = 준수, 0.5σ = 우수
const SKILLS = [0, 0.25, 0.5];
const M_MULT = [1, 1.5, 2, 3, 5]; // 목표 크기 = 하한 × 배수 (수익성 구간 경계와 동일)
const CS = [1, 3, 5, 10];
const N = 4000;

let seed = 987654321;
function rand(): number {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 0xffffffff;
}
function gauss(): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** 경로 하나 → (적중 여부, 판정가) — 실제 판정 규칙과 동일 */
function simulateOutcome(sigma: number, drift: number, M: number, H: number) {
  const target = 1 + M / 100;
  let s = 1;
  let lastClose = 1;
  for (let t = 0; t < H; t++) {
    s *= Math.exp(drift * sigma - 0.5 * sigma * sigma + sigma * gauss());
    lastClose = s;
    if (s >= target) return { hit: true, settled: 100 * target };
  }
  return { hit: false, settled: 100 * lastClose };
}

for (const mkt of MARKETS) {
  const floor = PROFITABILITY_BASE_PCT[mkt.assetClass];
  console.log(`\n━━━ ${mkt.label} · 하한 ${floor}% ━━━`);
  for (const skill of SKILLS) {
    // M별 결과 분포를 한 번 만들고 (c,s) 그리드는 같은 결과에 점수만 다시 매긴다
    const outcomes = new Map<number, { hit: boolean; settled: number }[]>();
    for (const mult of M_MULT) {
      seed = 987654321 + mult * 7; // M별 고정 시드 (skill 간 비교 가능)
      const M = floor * mult;
      const rows: { hit: boolean; settled: number }[] = [];
      for (let i = 0; i < N; i++) rows.push(simulateOutcome(mkt.sigma, skill, M, mkt.H));
      outcomes.set(mult, rows);
    }

    type Best = { ev: number; M: number; c: number; s: number; hitRate: number; stabShare: number };
    const best: Record<'current' | 'noStab', Best> = {
      current: { ev: -Infinity, M: 0, c: 0, s: 0, hitRate: 0, stabShare: 0 },
      noStab: { ev: -Infinity, M: 0, c: 0, s: 0, hitRate: 0, stabShare: 0 },
    };

    for (const mult of M_MULT) {
      const M = floor * mult;
      const rows = outcomes.get(mult)!;
      const hitRate = rows.filter((r) => r.hit).length / N;
      for (const c of CS) for (const s of CS) {
        let evCur = 0; let evDir = 0;
        for (const r of rows) {
          const sc = scoreJudgedCard({
            direction: 'UP', targetType: 'RETURN_PCT', targetValue: M,
            confidence: c, assetClass: mkt.assetClass, sigmaDaily: null,
            basePrice: 100, settledPrice: r.settled, horizonDays: mkt.H, outcome: r.hit ? 'HIT' : 'MISS',
          });
          evCur += sc.score; evDir += sc.directionScore;
        }
        evCur /= N; evDir /= N;
        if (evCur > best.current.ev) {
          best.current = { ev: evCur, M, c, s, hitRate, stabShare: evCur !== 0 ? 1 - evDir / evCur : 0 };
        }
        if (s === 1 && evDir > best.noStab.ev) {
          // 대안 A: 안정성 기여 제거 = s를 판에서 빼고 방향 점수만 본다
          best.noStab = { ev: evDir, M, c, s: 0, hitRate, stabShare: 0 };
        }
      }
    }

    const f = (b: Best) =>
      `M=${b.M}% c=${b.c}${b.s ? ` s=${b.s}` : ''} → EV ${b.ev.toFixed(0)}점/장 (적중률 ${(b.hitRate * 100).toFixed(0)}%${b.s ? `, 안정성 몫 ${(b.stabShare * 100).toFixed(0)}%` : ''})`;
    console.log(`  실력 ${skill}σ`);
    console.log(`    현행:   최적 ${f(best.current)}`);
    console.log(`    대안A:  최적 ${f(best.noStab)}`);
  }
}
