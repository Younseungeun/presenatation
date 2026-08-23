import { compositeStars } from "@/domain/ratingStars";
import type { ProfitabilityLevel } from "@/domain/profitability";

// 확신 종합 별점 — 얇은 순위표(BestSellers)용 별 5개 하나.
//
// 카드처럼 별 세 줄을 늘어놓을 자리가 없는 행에서, 확신을 숫자 하나로 접는다.
// 접는 방식은 **점수 기여 가중**이다 (domain/ratingStars.ts):
//   수익성(맞으면 얼마나 버나) 0.21 + 신뢰도(얼마나 맞을 것 같나) 0.79.
// 안정성은 들어가지 않는다 — 점수 기여가 0이라 무게도 0이고, 애초에 이 별은
// 리서처가 건 확신을 요약하는 자리다 (안정성은 종목의 성질이지 리서처의 주장이 아니다).
//
// **수식을 옮겨 적지 않는다** — 목록 정렬(marketQueries.ratingAverage)과 같은 함수를
// 부른다. 같은 카드가 순위표에서는 별 4.2개, 정렬에서는 4.5개로 취급되면 어느 쪽이
// 맞는지 사용자가 판단해야 한다.

export function convictionStars(
  assetClass: string | null,
  confidence: number | null,
  profitability: ProfitabilityLevel | null = null,
): number | null {
  if (!assetClass) return null;
  return compositeStars({ profitability, confidence });
}
