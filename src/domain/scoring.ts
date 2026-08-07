import type { AssetClass, Direction, Outcome, TargetType } from './constants';

// 점수 산정 (등급의 유일한 기준 — 경쟁적 요소).
//
// 규칙 (기획 확정):
// - 기본 점수: 크기(%) 적중 비율. 예측 +30%에 실현 +3%면 3/30×100 = 10점
// - 부호: 방향(buy/sell)을 맞추면 +, 틀리면 −
// - 증폭 (proper scoring rule — 비대칭):
//     맞으면 × c (신뢰도 1당 증폭 1, 기획 원안 유지)
//     틀리면 × c(c+1)/2 (벌점은 신뢰도에 대해 초선형)
//   이렇게 하면 신뢰도 c를 거는 것이 최적이 되는 승률이 p*(c) = (c+0.5)/(c+1.5)로
//   유일하게 결정된다: c=1 ⇔ 60%, c=3 ⇔ 78%, c=5 ⇔ 85%, c=10 ⇔ 91%.
//   → 신뢰도가 정직한 확률 신호가 되고, 승률 50%(동전 던지기)는 어떤 신뢰도를
//   골라도 기대 점수 ≤ 0이라 물량 그라인딩이 차단된다.
//   (대칭 ×c 증폭의 문제: EV+면 무조건 10이 최적 → 10단계가 2단계로 붕괴)
//
// - 초소형 크기 예측 방지: 자산군별 크기 하한 (MIN_MAGNITUDE_PCT).
//   상한 100 컷 아래에서 "+1% 예측"은 사실상 방향 맞히기로 만점이 되므로,
//   예측 크기가 자산군 변동성 대비 유의미하도록 강제한다
//
// 스펙에 없어 이 구현이 정한 것 (CLAUDE.md §2.2에 확정 필요로 표기):
// - 초과 달성 상한: 실현이 예측 크기를 넘어도 기본 점수는 100점에서 자른다
// - 마이너스 기본 점수: 플러스와 같은 비율 공식 (틀린 방향 실현 크기 / 예측 크기, 상한 100)
// - 실현 0% 또는 판정 불가·철회: 0점 (표본 제외)

export const CONFIDENCE_RANGE = { min: 1, max: 10 } as const;
export const BASE_SCORE_CAP = 100;

/**
 * 자산군별 예측 크기(%) 하한 — 초안, 시뮬레이션으로 확정 예정.
 * 자산군 변동성 기준: 주식은 일 ±2~3%가 흔하므로 5%, 코인은 ±10%가 흔하므로 10%.
 * 주의: 단기(당일~2일) 카드에는 이 하한이 사실상 "달성 어려운 크기"라 기본 점수가
 * 낮게 나온다 — 단타는 저점수 다건, 장기는 고점수 소건으로 자연 균형 (검증 필요)
 */
export const MIN_MAGNITUDE_PCT: Record<AssetClass, number> = {
  KR_EQUITY: 5,
  US_EQUITY: 5,
  CRYPTO: 10,
};

/**
 * 30일 기준 예측 크기(%) 상한 — 초안.
 *
 * 하한만 있고 상한이 없으면 "삼성전자 1주일 +80%" 같은 카드를 막을 수 없다.
 * 점수는 어차피 낮게 나오지만, 리포트 목록에는 "+80% 전망"이라는 자극적인 문구가
 * 걸리고 구매자는 그 숫자를 보고 산다 — 달성 불가능한 크기는 그 자체로 낚시다.
 */
export const MONTHLY_MAGNITUDE_CAP_PCT: Record<AssetClass, number> = {
  KR_EQUITY: 50,
  US_EQUITY: 50,
  CRYPTO: 120,
};

/**
 * 기간을 반영한 크기 상한.
 * 변동성은 시간의 제곱근에 비례하므로(랜덤워크) 30일 기준 상한을 √(일수/30)로 스케일한다.
 * 고정 상한을 쓰면 단기 카드에는 너무 헐겁고 장기 카드에는 너무 빡빡해진다.
 *
 * 예(국내주식): 1일 9% / 7일 24% / 30일 50% / 90일 87% / 365일 174%
 *   (코인): 1일 22% / 7일 58% / 30일 120% / 90일 208% / 365일 419%
 * 넘으면 게시 보류(WARN)이지 거절이 아니다 — 정당한 고위험 콜은 운영자가 승인한다.
 */
export function maxMagnitudePct(assetClass: AssetClass, horizonDays: number): number {
  const days = Math.max(1, horizonDays);
  return MONTHLY_MAGNITUDE_CAP_PCT[assetClass] * Math.sqrt(days / 30);
}

/** 방향 적중 시 증폭 배율 */
export function winAmplifier(confidence: number): number {
  return confidence;
}

/** 방향 실패 시 증폭 배율 — 신뢰도에 초선형 (proper scoring) */
export function lossAmplifier(confidence: number): number {
  return (confidence * (confidence + 1)) / 2;
}

/** 신뢰도 c가 최적 선택이 되는 승률 (프로필·작성 화면 안내용) */
export function optimalWinRateFor(confidence: number): number {
  return (confidence + 0.5) / (confidence + 1.5);
}

// ── 마이너스 점수 규율 (자산군별 적용) ─────────────────────────────────
// 누적 점수가 깊은 마이너스로 갈수록 작성 가능한 최소 신뢰도가 올라간다.
// proper scoring 구조에서 이 하한은 선별적으로 작동한다:
// - 실력자(승률 78%+)는 최적 신뢰도가 이미 3 이상이라 영향 없음
// - 승률 50~60% 저품질 대량 게시자는 신뢰도 1의 "기대 점수 ≈ 0" 은신처를 잃고
//   기대 점수가 확실한 마이너스로 뒤집혀, 시행을 늘릴수록 다음 단계에 더 빨리 도달
// 최하단은 강제 탈퇴 대신 해당 자산군 신규 게시 정지(시즌 종료까지) —
// 진행 중인 에스크로·판정은 정상 처리하고, 시즌 리셋으로 부활 기회를 준다.
// 점수가 회복되면 하한은 자동으로 완화된다 (현재 점수의 함수).

export interface Discipline {
  /** 작성 가능한 최소 신뢰도 (1이면 제약 없음) */
  minConfidence: number;
  /** 해당 자산군 신규 게시 정지 여부 */
  publishSuspended: boolean;
}

/** 규율 래더 — 수치는 초안, 시뮬레이션으로 확정 예정. scoreBelow 이하일 때 적용 */
export const DISCIPLINE_LADDER: ReadonlyArray<{ scoreBelow: number } & Discipline> = [
  { scoreBelow: -10_000, minConfidence: 10, publishSuspended: true },
  { scoreBelow: -6_000, minConfidence: 7, publishSuspended: false },
  { scoreBelow: -3_000, minConfidence: 5, publishSuspended: false },
  { scoreBelow: -1_000, minConfidence: 3, publishSuspended: false },
];

/** 자산군별 누적 점수 → 현재 적용되는 규율 */
export function disciplineFor(assetClassScore: number): Discipline {
  for (const rung of DISCIPLINE_LADDER) {
    if (assetClassScore <= rung.scoreBelow) {
      return { minConfidence: rung.minConfidence, publishSuspended: rung.publishSuspended };
    }
  }
  return { minConfidence: CONFIDENCE_RANGE.min, publishSuspended: false };
}

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
  /** 적용된 증폭 배율 (적중: c / 실패: c(c+1)/2) */
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
    return { directionHit: null, baseScore: 0, amplifier: 0, score: 0 };
  }

  const directionHit =
    card.direction === 'UP' ? realizedReturnPct > 0 : realizedReturnPct < 0;
  const baseScore = Math.min(
    (Math.abs(realizedReturnPct) / card.predictedMagnitudePct) * 100,
    BASE_SCORE_CAP,
  );
  const amplifier = directionHit ? winAmplifier(card.confidence) : lossAmplifier(card.confidence);
  const score = (directionHit ? 1 : -1) * baseScore * amplifier;
  return { directionHit, baseScore, amplifier, score };
}

/** 목표가형 카드의 예측 크기(%) 환산: 기준가 대비 목표가 거리 */
export function targetPriceToMagnitudePct(targetPrice: number, basePrice: number): number {
  if (basePrice <= 0) throw new Error(`기준가가 유효하지 않습니다: ${basePrice}`);
  return (Math.abs(targetPrice - basePrice) / basePrice) * 100;
}

export interface JudgedCardScoreInput {
  direction: Direction;
  targetType: TargetType;
  /** 예측 크기: RETURN_PCT는 등락률(%), TARGET_PRICE는 목표가 */
  targetValue: number;
  confidence: number;
  /** 기준가 (소급 확정 후 값). 없으면 점수 0 */
  basePrice: number | null;
  /** 판정 종가. 없으면 점수 0 */
  settledPrice: number | null | undefined;
  outcome: Outcome;
}

/**
 * 판정 결과 → 실현 등락률·점수 (§2.2). 판정 불가·데이터 결측은 0점(표본 제외).
 * 배치가 카드별로 호출한다.
 */
export function scoreJudgedCard(input: JudgedCardScoreInput): {
  realizedReturnPct: number | null;
  score: number;
} {
  if (input.outcome === 'UNDECIDABLE' || input.settledPrice == null || !input.basePrice) {
    return { realizedReturnPct: null, score: 0 };
  }
  const realizedReturnPct = ((input.settledPrice - input.basePrice) / input.basePrice) * 100;
  const predictedMagnitudePct =
    input.targetType === 'RETURN_PCT'
      ? input.targetValue
      : targetPriceToMagnitudePct(input.targetValue, input.basePrice);
  const { score } = computeCardScore(
    { direction: input.direction, predictedMagnitudePct, confidence: input.confidence },
    realizedReturnPct,
  );
  return { realizedReturnPct, score };
}
