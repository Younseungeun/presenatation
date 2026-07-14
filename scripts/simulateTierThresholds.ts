// 등급 임계값 검증 시뮬레이션 (CLAUDE.md §3.1 초안 수치)
// 실행: npx tsx scripts/simulateTierThresholds.ts
//
// 1단계 목표(검증된 리서처 30~50명 유치·유지)에 맞는 임계값인지 확인:
// - 등급 분포가 피라미드인가 (신호 가치)
// - 준수한 리서처(승률 65~70%)가 1~2시즌 내 실버에 닿는가 (승급 동기 — 이탈 방지)
// - 시즌 간 등급 유지율 (강등 요요가 심하면 지속 가능성 훼손)
//
// 가정: 시즌(분기) 점수 리셋, 리서처는 자기 승률에 맞는 최적 신뢰도 사용(proper scoring
// 유도 결과), 기본 점수 U(20,100), 게시량은 주 1~3장(시즌 12~40장, 활동적일수록 많음).

import { lossAmplifier, winAmplifier } from '../src/domain/scoring';
import { evaluateTier, type TierThresholds } from '../src/domain/tiers';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 초기 공급자 풀 가정 (경력자 직접 영입 전제 — 완전 무실력은 적음) */
const SKILL_POOL: Array<{ share: number; pMin: number; pMax: number }> = [
  { share: 0.2, pMin: 0.5, pMax: 0.55 }, // 사실상 무실력
  { share: 0.35, pMin: 0.6, pMax: 0.67 }, // 준수 하단
  { share: 0.3, pMin: 0.68, pMax: 0.75 }, // 준수 상단
  { share: 0.12, pMin: 0.76, pMax: 0.83 }, // 상위
  { share: 0.03, pMin: 0.84, pMax: 0.9 }, // 최상위
];

function samplePool(rng: () => number): { p: number; cardsPerSeason: number } {
  let x = rng();
  for (const b of SKILL_POOL) {
    if (x < b.share) {
      const p = b.pMin + rng() * (b.pMax - b.pMin);
      // 실력이 있을수록 활동적이라고 가정 (판매가 되니까): 12~40장
      const cards = Math.round(12 + rng() * 28 * ((p - 0.5) / 0.4 + 0.5));
      return { p, cardsPerSeason: Math.min(cards, 40) };
    }
    x -= b.share;
  }
  return { p: 0.55, cardsPerSeason: 15 };
}

/** proper scoring 하의 합리적 신뢰도 선택 */
function rationalConfidence(p: number): number {
  return Math.max(1, Math.min(10, Math.round(p / (1 - p) - 0.5)));
}

function seasonScore(p: number, cards: number, rng: () => number): number {
  const c = rationalConfidence(p);
  let score = 0;
  for (let i = 0; i < cards; i++) {
    const base = 20 + rng() * 80;
    score += rng() < p ? base * winAmplifier(c) : -base * lossAmplifier(c);
  }
  return score;
}

const CANDIDATES: Record<string, TierThresholds> = {
  '낮춤 (600/2k/5k)': { SILVER: 600, GOLD: 2_000, PLATINUM: 5_000 },
  '현행 (1k/3k/8k)': { SILVER: 1_000, GOLD: 3_000, PLATINUM: 8_000 },
  '높임 (1.5k/5k/12k)': { SILVER: 1_500, GOLD: 5_000, PLATINUM: 12_000 },
};

const TRIALS = 20_000;
const rng = mulberry32(2026);

// 리서처 풀 생성 후 두 시즌 시뮬레이션 (유지율 측정)
const pool = Array.from({ length: TRIALS }, () => samplePool(rng));
const season1 = pool.map((r) => seasonScore(r.p, r.cardsPerSeason, rng));
const season2 = pool.map((r) => seasonScore(r.p, r.cardsPerSeason, rng));

for (const [name, th] of Object.entries(CANDIDATES)) {
  const dist = { BRONZE: 0, SILVER: 0, GOLD: 0, PLATINUM: 0 };
  let silverKept = 0;
  let silverCount = 0;
  let decentReachSilver = 0;
  let decentCount = 0;

  pool.forEach((r, i) => {
    const t1 = evaluateTier(season1[i], th);
    dist[t1]++;
    if (t1 !== 'BRONZE') {
      silverCount++;
      if (evaluateTier(season2[i], th) !== 'BRONZE') silverKept++;
    }
    if (r.p >= 0.65 && r.p <= 0.72) {
      decentCount++;
      if (t1 !== 'BRONZE') decentReachSilver++;
    }
  });

  const pct = (n: number) => ((n / TRIALS) * 100).toFixed(1).padStart(5);
  console.log(`\n${name}`);
  console.log(
    `  분포: 브론즈 ${pct(dist.BRONZE)}%  실버 ${pct(dist.SILVER)}%  골드 ${pct(dist.GOLD)}%  플래티넘 ${pct(dist.PLATINUM)}%`,
  );
  console.log(
    `  준수한 리서처(승률 65~72%)의 첫 시즌 실버+ 도달률: ${((decentReachSilver / decentCount) * 100).toFixed(1)}%`,
  );
  console.log(
    `  실버+ 등급의 다음 시즌 유지율(강등 요요 지표): ${((silverKept / silverCount) * 100).toFixed(1)}%`,
  );
}
