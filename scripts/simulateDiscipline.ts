// 마이너스 점수 규율 래더 수치 검증 시뮬레이션 (CLAUDE.md §2.2 / §6.5)
// 실행: npx tsx scripts/simulateDiscipline.ts
//
// 리서처 유형별로 카드 게시를 몬테카를로 시뮬레이션해서
// - 각 규율 단계(-1,000/-3,000/-6,000/-10,000)에 도달하는 비율
// - 게시 정지까지 걸리는 카드 수
// - 실력자가 불운으로 규율에 걸렸을 때의 회복률
// 을 측정한다. 목적: 임계값이 "실력 없는 리서처는 빠르게 멈추고,
// 실력 있는 리서처는 억울하게 죽지 않는" 균형인지 확인.

import { disciplineFor, lossAmplifier, winAmplifier } from '../src/domain/scoring';

interface Archetype {
  name: string;
  winRate: number;
  /** 본인이 선호하는 신뢰도 (규율로 하한이 생기면 max(선호, 하한) 사용) */
  preferredConfidence: number;
}

const ARCHETYPES: Archetype[] = [
  { name: '동전 던지기·소심 (p=0.50, c=1)', winRate: 0.5, preferredConfidence: 1 },
  { name: '동전 던지기·과신 (p=0.50, c=5)', winRate: 0.5, preferredConfidence: 5 },
  { name: '경계선 스패머 (p=0.55, c=1)', winRate: 0.55, preferredConfidence: 1 },
  { name: '준수한 실력자 (p=0.70, c=2)', winRate: 0.7, preferredConfidence: 2 },
  { name: '상위 실력자 (p=0.85, c=5)', winRate: 0.85, preferredConfidence: 5 },
];

/** 기본 점수 분포: 크기 하한 덕분에 0 근처보다 중간~상단이 흔하다고 가정 (균등 20~100) */
function sampleBase(rng: () => number, mean: 'stock' | 'crypto'): number {
  // 주식: 실현/예측 비율이 낮게 깔림 (하한 5% 대비 실현 1~5%가 흔함)
  // 코인: 변동성이 커서 비율 상단·컷(100)이 흔함
  return mean === 'stock' ? 20 + rng() * 80 : 40 + rng() * 60;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNGS = [-1_000, -3_000, -6_000, -10_000];
const CARDS_PER_SEASON = 200; // 분기 시즌 동안 매우 부지런한 리서처 가정
const TRIALS = 10_000;

function simulate(arch: Archetype, market: 'stock' | 'crypto', seed: number) {
  const rng = mulberry32(seed);
  const rungHit = [0, 0, 0, 0];
  const suspendedAt: number[] = [];
  let recoveredAfterRung1 = 0;
  let hitRung1 = 0;
  let finalScoreSum = 0;

  for (let t = 0; t < TRIALS; t++) {
    let score = 0;
    const seen = [false, false, false, false];
    let everRung1 = false;
    for (let n = 1; n <= CARDS_PER_SEASON; n++) {
      const discipline = disciplineFor(score);
      if (discipline.publishSuspended) {
        suspendedAt.push(n);
        break;
      }
      const c = Math.max(arch.preferredConfidence, discipline.minConfidence);
      const base = sampleBase(rng, market);
      const win = rng() < arch.winRate;
      score += win ? base * winAmplifier(c) : -base * lossAmplifier(c);

      RUNGS.forEach((r, i) => {
        if (score <= r && !seen[i]) {
          seen[i] = true;
          rungHit[i]++;
          if (i === 0) everRung1 = true;
        }
      });
    }
    if (everRung1) {
      hitRung1++;
      if (score > RUNGS[0]) recoveredAfterRung1++; // 시즌 말 기준 -1,000 위로 복귀
    }
    finalScoreSum += score;
  }

  return {
    rungPct: rungHit.map((h) => (h / TRIALS) * 100),
    suspendedPct: (suspendedAt.length / TRIALS) * 100,
    medianSuspendCards:
      suspendedAt.length > 0
        ? suspendedAt.sort((a, b) => a - b)[Math.floor(suspendedAt.length / 2)]
        : null,
    recoveryPct: hitRung1 > 0 ? (recoveredAfterRung1 / hitRung1) * 100 : null,
    avgFinal: finalScoreSum / TRIALS,
  };
}

for (const market of ['stock', 'crypto'] as const) {
  console.log(`\n=== ${market === 'stock' ? '주식형 기본점수(평균 60)' : '코인형 기본점수(평균 70)'} — 시즌 ${CARDS_PER_SEASON}장, ${TRIALS}회 시행 ===`);
  console.log(
    '유형'.padEnd(30) +
      '-1k도달%  -3k%   -6k%   정지%   정지중앙값(장)  래더후회복%  평균최종점수',
  );
  for (const arch of ARCHETYPES) {
    const r = simulate(arch, market, 42);
    console.log(
      arch.name.padEnd(32) +
        r.rungPct[0].toFixed(1).padStart(6) +
        r.rungPct[1].toFixed(1).padStart(7) +
        r.rungPct[2].toFixed(1).padStart(7) +
        r.suspendedPct.toFixed(1).padStart(7) +
        String(r.medianSuspendCards ?? '—').padStart(12) +
        (r.recoveryPct === null ? '—' : r.recoveryPct.toFixed(1)).padStart(12) +
        Math.round(r.avgFinal).toLocaleString().padStart(14),
    );
  }
}
