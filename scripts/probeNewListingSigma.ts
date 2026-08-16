import {
  minMagnitudePct,
  maxMagnitudePct,
  noSkillTouchProbability,
  computeReachScore,
  DAILY_SIGMA,
  UNMEASURED_SIGMA,
} from '@/domain/scoring';
import type { AssetClass } from '@/domain/constants';

// σ를 못 잰 종목(신규 상장·조회 실패)에서 폴백을 무엇으로 두느냐가 얼마나 벌어지나.
//
// fetchRealizedSigma는 표본 20거래일 미만이면 null을 돌려준다 — 즉 **상장·거래된 지
// 얼마 안 된 종목**은 구조적으로 σ가 없다. 그런 종목이야말로 관심도에 따라 급등락을
// 반복하므로, 폴백을 "자산군 평균"으로 두면 틀린 방향으로 가장 크게 틀린다.
//
// 재는 것: 실력이 0인 사람이 그런 종목만 골라 하한 크기로 카드를 낼 때의 카드당 기대 점수.
// vmax의 뼈대 성질은 "무실력자 기대값 ≤ 0"이고, 그것이 지켜지는지가 판단 기준이다.
//
//   npm run sim:unmeasured

const CASES: { assetClass: AssetClass; realSigmas: number[] }[] = [
  { assetClass: 'KR_EQUITY', realSigmas: [0.04, 0.06, 0.08] },
  { assetClass: 'CRYPTO', realSigmas: [0.08, 0.12, 0.16] },
];
const HORIZONS = [7, 14, 30, 90];
const SENIOR_LINE = 1_200; // DEFAULT_TIER_THRESHOLDS.SILVER

function evPerCard(
  assetClass: AssetClass,
  fallback: number,
  realSigma: number,
  days: number,
  confidence: number,
): number {
  const floor = minMagnitudePct(assetClass, fallback, days);
  const trueP = noSkillTouchProbability('UP', floor, assetClass, days, realSigma);
  const hit = computeReachScore('UP', floor, confidence, assetClass, days, true, fallback).score;
  const miss = computeReachScore('UP', floor, confidence, assetClass, days, false, fallback).score;
  return trueP * hit + (1 - trueP) * miss;
}

for (const { assetClass, realSigmas } of CASES) {
  const avg = DAILY_SIGMA[assetClass];
  const rough = UNMEASURED_SIGMA[assetClass];
  console.log(`\n═══ ${assetClass} — 평균 폴백 ${(avg * 100).toFixed(1)}% vs 거친 폴백 ${(rough * 100).toFixed(1)}%`);
  console.log('\n  ① 모델이 보는 무정보 도달 확률 vs 실제 (평균 폴백일 때)');
  console.log(`  기간   하한    모델 p₀   실제 p₀ (σ=${realSigmas.map((s) => `${(s * 100).toFixed(0)}%`).join(' / ')})`);
  for (const days of HORIZONS) {
    const floor = minMagnitudePct(assetClass, avg, days);
    const model = noSkillTouchProbability('UP', floor, assetClass, days, avg);
    const real = realSigmas.map((s) => noSkillTouchProbability('UP', floor, assetClass, days, s));
    console.log(
      `  ${String(days).padStart(3)}일  ${floor.toFixed(1).padStart(5)}%  ${(model * 100).toFixed(1).padStart(6)}%  ` +
        real.map((p) => `${(p * 100).toFixed(1).padStart(7)}%`).join(''),
    );
  }

  for (const [label, fallback] of [['평균 폴백', avg], ['거친 폴백', rough]] as const) {
    console.log(`\n  ② 실력 0인 사람의 카드당 기대 점수 — ${label} (c=2 / c=5)`);
    console.log(`  기간   ${realSigmas.map((s) => `실제 σ=${(s * 100).toFixed(0)}%`.padStart(17)).join('')}`);
    for (const days of HORIZONS) {
      const cells = realSigmas.map((s) => {
        const a = evPerCard(assetClass, fallback, s, days, 2);
        const b = evPerCard(assetClass, fallback, s, days, 5);
        return `${a.toFixed(1).padStart(8)} /${b.toFixed(1).padStart(7)}`;
      });
      console.log(`  ${String(days).padStart(3)}일   ${cells.join('  ')}`);
    }
  }

  const worst = Math.max(
    ...HORIZONS.flatMap((d) => realSigmas.flatMap((s) => [2, 5].map((c) => evPerCard(assetClass, rough, s, d, c)))),
  );
  console.log(
    `\n  → 거친 폴백에서 최악의 카드당 기대 점수 ${worst.toFixed(1)}` +
      (worst <= 0
        ? ' — 무실력자 기대값 ≤ 0 유지'
        : ` (시니어선 ${SENIOR_LINE}까지 ${Math.ceil(SENIOR_LINE / worst)}장)`),
  );
  const days30 = 30;
  console.log(
    `  → 게시 가능한 크기 창(30일, σ 미측정): ` +
      `${minMagnitudePct(assetClass, null, days30).toFixed(1)}% ~ ${maxMagnitudePct(assetClass, days30, null).toFixed(1)}%`,
  );
}
