import type { Tier } from './constants';

// 등급 승급 평가. 승급 = 건수 + 성과 복합 조건, 분기 시즌제 재산정(강등 포함).
// 기준 수치는 기획 문서상 "초안"이며 시뮬레이션으로 확정 예정 → 설정 주입 가능하게 유지.
// 챌린저는 상대평가(플래티넘 상위 5%)라 개별 평가 대상이 아니며 MVP 범위에서 제외.

export interface PromotionCriteria {
  /** 판정 완료 최소 건수 */
  minJudged: number;
  /** 최소 적중률 (0~1) — 성과 기준 초안 */
  minHitRate: number;
}

export const DEFAULT_PROMOTION_CRITERIA: Record<Exclude<Tier, 'BRONZE' | 'CHALLENGER'>, PromotionCriteria> = {
  SILVER: { minJudged: 10, minHitRate: 0.5 },
  GOLD: { minJudged: 25, minHitRate: 0.55 },
  PLATINUM: { minJudged: 50, minHitRate: 0.6 },
};

export interface ResearcherStats {
  /** 판정 완료(HIT/MISS) 건수 — 판정 불가 건은 표본에서 제외 */
  judgedCount: number;
  /** 적중률 (0~1) */
  hitRate: number;
  /** 경력 인증 배지 보유 시 건수 기준 절반으로 완화 */
  hasCareerBadge: boolean;
}

/**
 * 시즌 재산정 시점의 등급을 계산한다. 조건을 만족하는 최상위 등급을 반환하며,
 * 기존 등급보다 낮으면 강등이다 (강등 시 기존 구독자 유지, 신규 판매만 제한 — 판매 레이어에서 처리).
 */
export function evaluateTier(
  stats: ResearcherStats,
  criteria = DEFAULT_PROMOTION_CRITERIA,
): Exclude<Tier, 'CHALLENGER'> {
  const ladder: Array<'PLATINUM' | 'GOLD' | 'SILVER'> = ['PLATINUM', 'GOLD', 'SILVER'];
  for (const tier of ladder) {
    const c = criteria[tier];
    const minJudged = stats.hasCareerBadge ? Math.ceil(c.minJudged / 2) : c.minJudged;
    if (stats.judgedCount >= minJudged && stats.hitRate >= c.minHitRate) {
      return tier;
    }
  }
  return 'BRONZE';
}
