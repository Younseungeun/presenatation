import type { Direction } from './constants';

// 점수 산정 (등급의 유일한 기준 — 경쟁적 요소).
//
// 규칙 (기획 확정):
// - 기본 점수: 크기(%) 적중 비율. 예측 +30%에 실현 +3%면 3/30×100 = 10점
// - 부호: 방향(buy/sell)을 맞추면 +, 틀리면 −
// - 증폭: 리서처가 자기 주장한 신뢰도(1~10단계)를 그대로 곱한다 (신뢰도 1당 증폭 1)
//
// 스펙에 없어 이 구현이 정한 것 (CLAUDE.md §2.2에 확정 필요로 표기):
// - 초과 달성 상한: 실현이 예측 크기를 넘어도 기본 점수는 100점에서 자른다
//   (상한이 없으면 +1% 예측에 +10% 실현 = 1,000점 같은 왜곡 발생)
// - 마이너스 크기: 플러스와 대칭 — 틀린 방향으로 실현된 크기의 비율(상한 100) × 신뢰도
// - 실현 0% 또는 판정 불가·철회: 0점 (표본 제외)

export const CONFIDENCE_RANGE = { min: 1, max: 10 } as const;
export const SELF_RATING_RANGE = { min: 1, max: 10 } as const;
export const BASE_SCORE_CAP = 100;

export interface ScorableCard {
  direction: Direction;
  /** 예측 크기(%): 양수. RETURN_PCT는 targetValue 그대로, TARGET_PRICE는 기준가 대비 환산 */
  predictedMagnitudePct: number;
  /** 자기 주장 신뢰도 1~10 — 그대로 증폭 배율이 된다 */
  confidence: number;
}

export interface CardScore {
  /** 방향 적중 여부 (실현 0%면 null — 무승부) */
  directionHit: boolean | null;
  /** 크기 적중 비율 점수 0~100 */
  baseScore: number;
  /** 신뢰도 증폭 배율 */
  amplifier: number;
  /** 최종 점수 = ±기본 점수 × 증폭 */
  score: number;
}

/**
 * 판정 완료된 카드 1건의 점수.
 * @param realizedReturnPct 기준가 대비 실현 등락률(%). 부호 있음 (하락 = 음수)
 */
export function computeCardScore(card: ScorableCard, realizedReturnPct: number): CardScore {
  if (card.predictedMagnitudePct <= 0) {
    throw new Error(`예측 크기는 양수여야 합니다: ${card.predictedMagnitudePct}`);
  }
  if (card.confidence < CONFIDENCE_RANGE.min || card.confidence > CONFIDENCE_RANGE.max) {
    throw new Error(`신뢰도는 ${CONFIDENCE_RANGE.min}~${CONFIDENCE_RANGE.max}입니다: ${card.confidence}`);
  }

  if (realizedReturnPct === 0) {
    return { directionHit: null, baseScore: 0, amplifier: card.confidence, score: 0 };
  }

  const directionHit =
    card.direction === 'UP' ? realizedReturnPct > 0 : realizedReturnPct < 0;
  const baseScore = Math.min(
    (Math.abs(realizedReturnPct) / card.predictedMagnitudePct) * 100,
    BASE_SCORE_CAP,
  );
  const score = (directionHit ? 1 : -1) * baseScore * card.confidence;
  return { directionHit, baseScore, amplifier: card.confidence, score };
}

/** 목표가형 카드의 예측 크기(%) 환산: 기준가 대비 목표가 거리 */
export function targetPriceToMagnitudePct(targetPrice: number, basePrice: number): number {
  if (basePrice <= 0) throw new Error(`기준가가 유효하지 않습니다: ${basePrice}`);
  return (Math.abs(targetPrice - basePrice) / basePrice) * 100;
}

/** 리서처 누적 점수 (등급 산정 입력) */
export function sumScores(scores: Array<Pick<CardScore, 'score'>>): number {
  return scores.reduce((acc, s) => acc + s.score, 0);
}
