import { type ProfitabilityLevel } from './profitability';
import {
  CONFIDENCE_RANGE,
  confidenceOddsMultiple,
  PROFITABILITY_PAYOUT_MULTIPLE,
} from './scoring';

// 별점의 단일 기준 — 표시·정렬·융합 별점이 모두 여기서 나온다.
//
// 화면마다 같은 값이 다른 별 개수로 보이면 어느 쪽이 맞는지 사용자가 판단해야 한다.
// 그래서 스케일과 가중치를 한 파일에 두고, 카드·순위표·정렬이 이것만 부른다.
//
// ── 세 축이 서로 다른 질문을 맡는다 ─────────────────────────────
//   · 수익성  = 맞으면 얼마나 버나  (예측 크기 → 5구간, profitability.ts)
//   · 안정성  = 가는 길이 얼마나 출렁이나 (종목 실현 변동성, stability.ts)
//   · 신뢰도  = 얼마나 맞을 것 같나 (리서처가 신고한 적중 확률)

/**
 * 신뢰도 c → 별 (★1 ~ ★5).
 *
 * 사다리가 **등비**(칸당 승산 ×1.71, 꼭대기 ×140)로 바뀌면서 별도 따라 바뀐다:
 * 로그 승산이 c에 선형이므로 **별도 c에 선형**으로 두는 것이 눈금과 일치한다.
 * 별 한 칸 = 승산 ×1.71 — 어느 구간에서든 같은 뜻이다.
 *
 * 예전(승률×5)을 버린 이유: 함의 승률은 이제 p₀에 따라 달라져(같은 c라도 카드마다
 * 다른 확률을 뜻한다) 카드 목록에 고정된 별로 그릴 수 없다. 게다가 목표 크기가
 * 가려진 화면에서 승률 기반 별을 그리면 p₀를 통해 크기가 역산될 여지가 생긴다.
 * 정확한 신고 확률은 **구매자가 그 카드의 사양을 아는 자리**(리포트 상세·작성 화면)에서
 * 각주로 싣는다.
 */
export function confidenceStars(confidence: number): number {
  const { min, max } = CONFIDENCE_RANGE;
  const t = (confidence - min) / (max - min);
  return 1 + 4 * Math.min(1, Math.max(0, t));
}

/**
 * 수익성 구간의 **대표 배수** — 점수 가중(scoring.magnitudeWeight)과 같은 눈금을
 * 써야 해서 domain/scoring.ts가 원본을 들고 있다. 여기서는 다시 내보내기만 한다.
 */
export { PROFITABILITY_PAYOUT_MULTIPLE };

/**
 * 수익성 구간 → **버는 크기 기준** 별 (1~5).
 * 카드에 그대로 뜨는 수익성 별은 구간 번호(정수)지만, 신뢰도와 섞어 하나로 만들 때는
 * "구간 하나 올라가면 실제로 얼마나 더 버나"가 맞는 눈금이다 — 구간 폭이 고르지 않아
 * (1.5F 폭 vs 2F 폭) 번호를 그대로 쓰면 위쪽 구간의 값이 눌린다.
 * 대표 배수의 로그를 1~5로 편다: ★1.00 / 1.85 / 2.69 / 3.81 / 5.00.
 */
export function profitabilityPayoutStars(level: ProfitabilityLevel): number {
  const lo = Math.log(PROFITABILITY_PAYOUT_MULTIPLE[1]);
  const hi = Math.log(PROFITABILITY_PAYOUT_MULTIPLE[5]);
  return 1 + (4 * (Math.log(PROFITABILITY_PAYOUT_MULTIPLE[level]) - lo)) / (hi - lo);
}

/**
 * 융합 별점의 가중치 — **점수 산정 기여만큼** 준다.
 * "별점 높은 순"이 곧 "점수를 크게 움직이는 확신 순"이 되도록.
 *
 * 유도 (인투빌 점수 산정 모델 vmax: S·w·ln(p̂/p₀) 또는 S·w·ln((1−p̂)/(1−p₀)),
 * scoring.ts) — 별 **한 칸**이 점수 크기를 몇 배 움직이는지(칸당 로그 기울기)를
 * 두 축에서 잰다:
 *   · 수익성: 가중 w가 구간 1→5에서 1.00 → 2.00 → ln2를 별 칸 수(4)로 나눈다
 *   · 신뢰도: 신고 승산이 c=2→10에서 ×140^(8/9) → 그 로그를 별 칸 수(4)로 나눈다
 * 무게 = 기울기 비율. 실측 **수익성 0.136 / 신뢰도 0.864** — 신뢰도가 압도적으로
 * 무거운 것이 맞다. 수익성은 점수를 최대 2배 키우지만, 신뢰도는 신고 자체를 바꿔
 * 정보량의 **부호와 크기**를 결정한다.
 *
 * **상수를 손으로 적지 않고 계산한다** — 신뢰도 하한이나 별 스케일, 수익성 가중
 * 상한이 바뀌면 이 값도 반드시 따라 움직여야 하는데, 손으로 적어 두면 한쪽만 고치고
 * 다른 쪽을 잊는다. 실제로 2026-08-13에 하한이 2로 오르고 수익성 가중이 연속으로
 * 펴지는 두 변경을 거쳤는데, 계산식이라 양쪽 모두 자동으로 반영됐다.
 *
 * 안정성은 여기 없다: 점수 기여가 0이므로 무게도 0 (종목 변동성 표시 전용).
 */
export const RATING_WEIGHT: { profitability: number; confidence: number } = (() => {
  // 수익성: 점수에 곱해지는 무게가 구간 1→5에서 1.00 → 2.00 (scoring.magnitudeWeight)
  const profitSlope = Math.log(2) / (profitabilityPayoutStars(5) - profitabilityPayoutStars(1));

  // 신뢰도: 별 1→5가 승산 ×1 → ×140 (scoring의 등비 사다리)
  const { min, max } = CONFIDENCE_RANGE;
  const confidenceSlope =
    Math.log(confidenceOddsMultiple(max) / confidenceOddsMultiple(min)) /
    (confidenceStars(max) - confidenceStars(min));

  const total = profitSlope + confidenceSlope;
  return { profitability: profitSlope / total, confidence: confidenceSlope / total };
})();

/**
 * 융합 별점 (0~5) — 수익성·신뢰도를 점수 기여 가중으로 합친다.
 * 한쪽만 있으면 그 별만으로 (분모도 그 무게만), 둘 다 없으면 null.
 *
 * 마스킹 안전: 입력은 **이미 공개된 값**뿐이다 (수익성 구간은 카드에 별로 떠 있고,
 * 신뢰도도 공개된다). 실제 목표 크기(%)를 넣으면 역산되므로 절대 넣지 않는다.
 */
export function compositeStars(input: {
  profitability: ProfitabilityLevel | null;
  confidence: number | null;
}): number | null {
  const parts: Array<{ stars: number; weight: number }> = [];
  if (input.profitability !== null) {
    parts.push({
      stars: profitabilityPayoutStars(input.profitability),
      weight: RATING_WEIGHT.profitability,
    });
  }
  if (input.confidence !== null) {
    parts.push({ stars: confidenceStars(input.confidence), weight: RATING_WEIGHT.confidence });
  }
  if (parts.length === 0) return null;
  const weightSum = parts.reduce((a, p) => a + p.weight, 0);
  return parts.reduce((a, p) => a + p.stars * p.weight, 0) / weightSum;
}
