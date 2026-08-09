import type { AssetClass } from "@/domain/constants";
import {
  CONFIDENCE_RANGE,
  DIRECTION_SCALE,
  MIN_MAGNITUDE_PCT,
  STABILITY_BASE_SCORE,
} from "@/domain/scoring";
import { confidenceStars, stabilityStars } from "./StarRating";

// 확신 종합 별점 — 신뢰도·안정성을 하나의 별 5개로 합친다 (얇은 순위표용).
//
// 가중치는 **점수 모델 v3에 실제로 기여하는 만큼**이다: 각 다이얼을 끝까지 올린
// 카드가 완벽 적중했을 때 그 다이얼이 벌 수 있는 최대 점수의 비율.
//   신뢰도(방향·크기 증폭) = DIRECTION_SCALE × 크기 하한 × c_max
//   안정성(정밀도 배팅)   = STABILITY_BASE_SCORE × (s_max − 1)   — s=1은 불참이라 −1
// 크기는 자산군 하한(MIN_MAGNITUDE_PCT)으로 고정한다 — 카드마다 실제 크기를 쓰면
// 가중치가 마스킹된 목표 크기를 역산하는 통로가 된다(수익성 5구간이 원값을 숨기는
// 이유와 같다). 하한 기준: 국내·미국주식 500:450, 코인 1000:450.
//
// **수식을 옮겨 적지 않고 정산 모듈의 상수에서 유도한다** (점수 계산기와 같은 원칙:
// 모델이 바뀌면 이 별점도 따라 바뀌어야 하고, 갈라지는 순간 화면이 거짓말을 한다).
//
// 수익성은 여기 들어가지 않는다 — v3 점수에 기여하지 않는 표시 지표라서다.
// (수익성은 방향 미니 그래프의 면 채움 진하기가 맡는다 — DirectionGlyph)

export interface ConvictionWeights {
  confidence: number;
  stability: number;
}

/** 자산군별 가중치 — 두 값의 합은 1 */
export function convictionWeights(assetClass: AssetClass): ConvictionWeights {
  const directionPotential =
    DIRECTION_SCALE * MIN_MAGNITUDE_PCT[assetClass] * CONFIDENCE_RANGE.max;
  const stabilityPotential = STABILITY_BASE_SCORE * (CONFIDENCE_RANGE.max - 1);
  const total = directionPotential + stabilityPotential;
  return {
    confidence: directionPotential / total,
    stability: stabilityPotential / total,
  };
}

/**
 * 신뢰도·안정성(각 1~10) → 별.
 * 표시 스케일은 카드의 개별 별점과 같은 함의 승률 매핑(StarRating 주석)을 쓴다 —
 * 같은 값이 화면마다 다른 별 개수로 보이면 어느 쪽이 맞는지 사용자가 판단해야 한다.
 * 별 5개(승률 100%)는 도달 불가이므로 이 종합도 최대 ≈4.5에서 멈춘다 — 표시의 일부다.
 */
export function convictionStars(
  assetClass: string | null,
  confidence: number | null,
  stability: number | null,
): number | null {
  if (!assetClass || confidence === null || stability === null) return null;
  if (!(assetClass in MIN_MAGNITUDE_PCT)) return null;
  const w = convictionWeights(assetClass as AssetClass);
  return (
    w.confidence * confidenceStars(confidence) + w.stability * stabilityStars(stability)
  );
}
