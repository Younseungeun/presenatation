import { PROFITABILITY_BOUNDS, type ProfitabilityLevel } from './profitability';
import { CONFIDENCE_RANGE, lossAmplifier, winAmplifier } from './scoring';

// 별점의 단일 기준 — 표시·정렬·융합 별점이 모두 여기서 나온다.
//
// 화면마다 같은 값이 다른 별 개수로 보이면 어느 쪽이 맞는지 사용자가 판단해야 한다.
// 그래서 스케일과 가중치를 한 파일에 두고, 카드·순위표·정렬이 이것만 부른다.
//
// ── 세 축이 서로 다른 질문을 맡는다 ─────────────────────────────
//   · 수익성  = 맞으면 얼마나 버나  (예측 크기 → 5구간, profitability.ts)
//   · 안정성  = 가는 길이 얼마나 출렁이나 (종목 실현 변동성, stability.ts)
//   · 신뢰도  = 얼마나 맞을 것 같나 (리서처가 건 승산 → 함의 승률)

/**
 * 신뢰도 c → 별. **함의 승률 × 5** — 다이얼은 선형이 아니라 승산 사다리라,
 * c가 c−1보다 유리할 조건 p ≥ c/(c+1)의 그 확률을 그대로 별로 옮긴다.
 * c=2 → ★3.33 (승률 66.7%), c=10 → ★4.55 (90.9%). ★5는 승률 100%라 도달 불가.
 *
 * **신뢰도 하한이 2로 오른 뒤에도 이 식을 그대로 둔다** (2026-08-13 판단).
 * 한때 "쓸 수 있는 구간이 ★3.33~4.55로 좁으니 눈금을 다시 펴자"고 바꿨다가 되돌렸다 —
 * c=2를 ★1로 그리면 **함의 승률 66.7%짜리 신고가 별 한 개로 보인다.** 압축된 것보다
 * 그쪽이 더 나쁜 거짓말이다. 별의 뜻이 "승률"인 것이 이 스케일의 전부이고,
 * 정확한 수치는 각주가 따로 싣는다(작성 화면·리포트 상세·/score).
 */
export function confidenceStars(confidence: number): number {
  return (5 * confidence) / (confidence + 1);
}

/**
 * 수익성 구간의 **대표 배수** — 그 구간 카드가 적중했을 때 실제로 버는 크기
 * (자산군 크기 하한 F의 몇 배인가). 구간의 기하 중점을 쓴다:
 * 경계가 등비에 가까워 산술 중점은 위쪽 구간을 과소평가한다.
 *
 * 마지막 구간은 열려 있어(≥5F) 중점이 없다 — 바로 아래 구간과 같은 로그 폭
 * ([3,5) → ln 5/3)을 위로 이어 붙여 [5, 8.3F)로 보고 그 중점을 쓴다.
 * 이 상수가 아래 가중치 유도의 입력이기도 해서, 한곳에서만 정의한다.
 */
export const PROFITABILITY_PAYOUT_MULTIPLE: Record<ProfitabilityLevel, number> = (() => {
  const edges = [1, ...PROFITABILITY_BOUNDS];
  const last = PROFITABILITY_BOUNDS[PROFITABILITY_BOUNDS.length - 1];
  const openTop = last * (last / PROFITABILITY_BOUNDS[PROFITABILITY_BOUNDS.length - 2]);
  const uppers = [...PROFITABILITY_BOUNDS, openTop];
  const mids = edges.map((lo, i) => Math.sqrt(lo * uppers[i]));
  return { 1: mids[0], 2: mids[1], 3: mids[2], 4: mids[3], 5: mids[4] };
})();

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
 * 유도 (점수 v4: 적중 +B·M·c·(1−p₀) / 실패 −B·M·c(c+1)/2·p₀, scoring.ts) —
 * 별 **한 칸**이 점수 크기를 몇 배 움직이는지(칸당 로그 기울기)를 두 축에서 잰다:
 *   · 수익성: 점수 ∝ M. 별 1→5의 대표 배수가 1.22F → 6.32F → ln(6.32/1.22)/4
 *   · 신뢰도: 증폭이 승·패에서 다르므로(c vs c(c+1)/2) 두 쪽 로그 폭의 평균을
 *     신뢰도 별의 칸 수로 나눈다
 * 무게 = 기울기 비율.
 *
 * **상수를 손으로 적지 않고 계산한다** — 신뢰도 하한(2)이나 별 스케일이 바뀌면
 * 이 값도 반드시 따라 움직여야 하는데, 손으로 적어 두면 한쪽만 고치고 다른 쪽을
 * 잊는다(실제로 2026-08-13 하한을 2로 올리며 칸 수가 2.05 → 3.55로 바뀌었다).
 *
 * 안정성은 여기 없다: 점수 기여가 0이므로 무게도 0 (종목 변동성 표시 전용).
 */
export const RATING_WEIGHT: { profitability: number; confidence: number } = (() => {
  const profitSlope =
    Math.log(PROFITABILITY_PAYOUT_MULTIPLE[5] / PROFITABILITY_PAYOUT_MULTIPLE[1]) / 4;

  const { min, max } = CONFIDENCE_RANGE;
  const winSpan = Math.log(winAmplifier(max) / winAmplifier(min));
  const lossSpan = Math.log(lossAmplifier(max) / lossAmplifier(min));
  const starSpan = confidenceStars(max) - confidenceStars(min);
  const confidenceSlope = (winSpan + lossSpan) / 2 / starSpan;

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
