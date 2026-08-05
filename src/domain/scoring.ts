import { type AssetClass, type Direction, type Outcome, type TargetType } from './constants';

// 점수 산정 v3 — 거리 기반 연속 모델 (2026-08-05 확정. 등급의 유일한 기준)
//
// 설계 원칙 (기획 조건):
//  · 신뢰도 c = 점수 증폭 변수 (비대칭 — 정직한 확률 신고가 최적이 되게)
//  · 수익성 = 표시용, 점수 무관
//  · 점수는 음수가 존재 — 스팸·무실력 리서처를 걸러낸다
//  · 안정성 = 실현이 예측에서 얼마나 떨어졌는지(거리)로 점수에 관여
//  · 사기적·버그적 방법이 통하지 않을 것
//
// 총점 = 방향·크기 점수 + 안정성 점수. 두 성분 모두 "거리"가 뼈대다.
//
// ── 성분 ① 방향·크기: 시장 기준선 대비 개선 거리 ──────────────────────
//   D = |R| − |R − R̂|  (%p, R̂ = 방향 부호 반영 예측 수익률)
//   "아무 예측도 안 한 사람(R̂=0)보다 얼마나 더 잘 맞혔나".
//   · 완벽 예측 → +|R̂|, 방향 반대 → 정확히 −|R̂| (자기 주장 크기만큼만 걸고 딴다)
//   · 본전은 실현 = 예측의 절반 지점, 초과해도 +|R̂|가 상한 (더 크게 올 걸 알면
//     더 크게 신고하는 것이 유일한 증점 경로 — 크기 과소 신고가 스스로 손해)
//   · 선형 손실이라 예측 크기의 최적 신고값 = 자기 믿음의 중앙값 (median-truthful).
//     구모델(적중 비율 + 100컷)의 "컷 위 무차별 → 과소 신고 스위트스팟"이 사라진다
//   · 무정보 예측은 E[D] < 0 (삼각부등식) — 증폭 이전에 이미 스팸이 음수
//
// ── 성분 ② 안정성: 연속 램프 정밀도 배팅 ─────────────────────────────
//   정규화 편차 δ = sign(R̂)·(R − R̂) / max(|R̂|, 자산군 바닥) — 비율 오차이되
//   초소형 예측에서는 절대 %p 바닥(주식 5 / 코인 10 = 크기 하한 재사용)으로 정규화.
//   초과(δ>0)는 1.5로 나눠 관대하게: ε = δ≥0 ? δ/1.5 : |δ|
//   · 착지 품질 q = max(0, 1 − ε/T): 명중 1 → T에서 0 (절벽 없음)
//   · 이탈 깊이 m = min(1, max(0, ε/T − 1)): T 지나며 차오르다 2T에서 최대
//   · 점수 = P₀·[(s−1)·q·(보정 없음) − (s−1)s/2·m], s=1은 양쪽 0인 진짜 불참
//   유효 배팅 s−1에 비대칭 벌점이 걸려 있어 최적 s가 자기 정밀도를 정직하게 드러낸다
//
// 실현 0%·판정 불가·철회: 총점 0 (표본 제외).
// 수치 검증: scripts/simScoreModel.ts (크기 정직성·c/s 정직성·악용 시나리오·스케일).

export const CONFIDENCE_RANGE = { min: 1, max: 10 } as const;

/** 방향·크기 점수 스케일 — 거리 1%p당 점수 (예측 +10% 완벽 적중 = 100×c로 구스케일 유지) */
export const DIRECTION_SCALE = 10;

/**
 * 자산군별 예측 크기(%) 하한 — 초안, 운영 데이터로 조정 예정.
 * 게시 검증(publishReport)과 안정성 정규화 바닥으로 함께 쓴다.
 */
export const MIN_MAGNITUDE_PCT: Record<AssetClass, number> = {
  KR_EQUITY: 5,
  US_EQUITY: 5,
  CRYPTO: 10,
};

/** 방향 개선(D>0) 시 증폭 배율 */
export function winAmplifier(confidence: number): number {
  return confidence;
}

/** 방향 악화(D<0) 시 증폭 배율 — 신뢰도에 초선형 (proper scoring) */
export function lossAmplifier(confidence: number): number {
  return (confidence * (confidence + 1)) / 2;
}

// ── 마이너스 점수 규율 (자산군별 적용) ─────────────────────────────
// 누적 점수가 깊은 마이너스로 갈수록 작성 가능한 최소 신뢰도가 올라간다.
// v3에서는 무정보 예측의 방향 성분 기대값이 증폭 이전에 이미 음수라
// 스팸의 래더 하강이 구조적으로 보장된다. 최하단은 강제 탈퇴 대신
// 해당 자산군 신규 게시 정지(시즌 종료까지) — 진행 중 에스크로·판정은 정상 처리.
// 점수가 회복되면 하한은 자동으로 완화된다 (현재 점수의 함수).

export interface Discipline {
  /** 작성 가능한 최소 신뢰도 (1이면 제약 없음) */
  minConfidence: number;
  /** 해당 자산군 신규 게시 정지 여부 */
  publishSuspended: boolean;
}

/**
 * 규율 래더 — scoreBelow 이하일 때 적용.
 * 1단(−1,000)의 최소 신뢰도는 3→2로 완화 (2026-08-05, 점수 v3 반영):
 * v3에서 중간 실력자의 정직한 최적 c가 1~2로 내려와, 3을 강제하면 일시 부진한
 * 실력자가 자기 최적보다 높은 배팅을 강요받아 하강이 가속되는 부작용이 있었다.
 * 스팸(카드당 EV −31.6)은 c=2 강제만으로도 벌점 배율이 1→3배가 되어 여전히 가속 하강.
 */
export const DISCIPLINE_LADDER: ReadonlyArray<{ scoreBelow: number } & Discipline> = [
  { scoreBelow: -10_000, minConfidence: 10, publishSuspended: true },
  { scoreBelow: -6_000, minConfidence: 7, publishSuspended: false },
  { scoreBelow: -3_000, minConfidence: 5, publishSuspended: false },
  { scoreBelow: -1_000, minConfidence: 2, publishSuspended: false },
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

function assertConfidence(confidence: number, label = '신뢰도'): void {
  if (confidence < CONFIDENCE_RANGE.min || confidence > CONFIDENCE_RANGE.max) {
    throw new Error(`${label}는 ${CONFIDENCE_RANGE.min}~${CONFIDENCE_RANGE.max}입니다: ${confidence}`);
  }
}

export interface DirectionScore {
  /** 시장 기준선 대비 개선 거리 D (%p). 완벽 +|R̂| ~ 방향 반대 −|R̂| */
  distance: number;
  /** DIRECTION_SCALE × D × (D>0 ? c : c(c+1)/2) */
  score: number;
}

/** 성분 ① 방향·크기 점수 */
export function computeDirectionScore(
  direction: Direction,
  predictedMagnitudePct: number,
  confidence: number,
  realizedReturnPct: number,
): DirectionScore {
  if (predictedMagnitudePct <= 0) {
    throw new Error(`예측 크기는 양수여야 합니다: ${predictedMagnitudePct}`);
  }
  assertConfidence(confidence);
  const signedTarget =
    direction === 'UP' ? predictedMagnitudePct : -predictedMagnitudePct;
  const distance =
    Math.abs(realizedReturnPct) - Math.abs(realizedReturnPct - signedTarget);
  const score =
    distance > 0
      ? DIRECTION_SCALE * distance * winAmplifier(confidence)
      : distance < 0
        ? DIRECTION_SCALE * distance * lossAmplifier(confidence)
        : 0;
  return { distance, score };
}

// ── 안정성 상수 ────────────────────────────────────────────────────
/** 정밀도 기본 점수 P₀ */
export const STABILITY_BASE_SCORE = 50;
/** 램프가 0이 되는 정규화 오차 T (2T에서 벌점 최대) */
export const STABILITY_TOLERANCE = 0.75;
/** 초과(예측 방향으로 더 간) 오차를 나누는 관대 계수 */
export const STABILITY_OVERSHOOT_RELIEF = 1.5;

export interface StabilityScore {
  /** 관대 계수 반영 정규화 오차 ε (0 = 정확히 명중) */
  normalizedError: number;
  /** P₀·[(s−1)·q − (s−1)s/2·m], s=1은 불참 0 */
  score: number;
}

/** 성분 ② 안정성 점수 — 연속 램프 정밀도 배팅 */
export function computeStabilityScore(
  direction: Direction,
  predictedMagnitudePct: number,
  stability: number,
  realizedReturnPct: number,
  /** 정규화 바닥(%p) — 자산군 크기 하한(MIN_MAGNITUDE_PCT)을 넘긴다 */
  normalizationFloorPct: number,
): StabilityScore {
  if (predictedMagnitudePct <= 0) {
    throw new Error(`예측 크기는 양수여야 합니다: ${predictedMagnitudePct}`);
  }
  assertConfidence(stability, '안정성');
  const signedTarget =
    direction === 'UP' ? predictedMagnitudePct : -predictedMagnitudePct;
  const denom = Math.max(predictedMagnitudePct, normalizationFloorPct);
  // δ > 0 = 예측 방향으로 초과, δ < 0 = 미달·역방향
  const delta =
    (Math.sign(signedTarget) * (realizedReturnPct - signedTarget)) / denom;
  const normalizedError = delta >= 0 ? delta / STABILITY_OVERSHOOT_RELIEF : -delta;
  if (stability <= 1) return { normalizedError, score: 0 }; // 불참
  const stake = stability - 1;
  const landQuality = Math.max(0, 1 - normalizedError / STABILITY_TOLERANCE);
  const missDepth = Math.min(1, Math.max(0, normalizedError / STABILITY_TOLERANCE - 1));
  const score =
    STABILITY_BASE_SCORE *
    (stake * landQuality - ((stake * stability) / 2) * missDepth);
  return { normalizedError, score };
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
  /** 자기 평가 안정성 1~10 — 정밀도 배팅 (1 = 불참) */
  stability: number;
  /** 자산군 — 안정성 정규화 바닥 결정 */
  assetClass: AssetClass;
  /** 기준가 (소급 확정 후 값). 없으면 점수 0 */
  basePrice: number | null;
  /** 판정 종가. 없으면 점수 0 */
  settledPrice: number | null | undefined;
  outcome: Outcome;
}

/**
 * 판정 결과 → 실현 등락률·점수 (§2.2). 판정 불가·데이터 결측은 0점(표본 제외).
 * 총점 = 방향·크기 점수 + 안정성 점수. 실현 0%는 무승부 — 모두 0점(표본 제외).
 * 배치·수동 판정이 카드별로 호출한다.
 */
export function scoreJudgedCard(input: JudgedCardScoreInput): {
  realizedReturnPct: number | null;
  score: number;
  /** 방향·크기 성분 (감사·화면 표시용) */
  directionScore: number;
  /** 안정성 성분 (감사·화면 표시용) */
  stabilityScore: number;
} {
  if (input.outcome === 'UNDECIDABLE' || input.settledPrice == null || !input.basePrice) {
    return { realizedReturnPct: null, score: 0, directionScore: 0, stabilityScore: 0 };
  }
  const realizedReturnPct = ((input.settledPrice - input.basePrice) / input.basePrice) * 100;
  if (realizedReturnPct === 0) {
    return { realizedReturnPct, score: 0, directionScore: 0, stabilityScore: 0 };
  }
  const predictedMagnitudePct =
    input.targetType === 'RETURN_PCT'
      ? input.targetValue
      : targetPriceToMagnitudePct(input.targetValue, input.basePrice);
  const { score: directionScore } = computeDirectionScore(
    input.direction,
    predictedMagnitudePct,
    input.confidence,
    realizedReturnPct,
  );
  const { score: stabilityScore } = computeStabilityScore(
    input.direction,
    predictedMagnitudePct,
    input.stability,
    realizedReturnPct,
    MIN_MAGNITUDE_PCT[input.assetClass],
  );
  return {
    realizedReturnPct,
    score: directionScore + stabilityScore,
    directionScore,
    stabilityScore,
  };
}
