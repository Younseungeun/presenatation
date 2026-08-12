import { confidenceStars } from "./StarRating";

// 확신 종합 별점 — 얇은 순위표(BestSellers)용 별 5개 하나.
//
// 점수 모델 v4(공정배당 이항, scoring.ts)에서 점수에 기여하는 자기 신고 다이얼은
// **신뢰도 하나뿐이다** — 안정성은 도달 판정에서 측정 대상(착지 정밀도)이 사라져
// 점수 기여가 제거됐다("경로 안정성" 배팅으로 재설계 전까지).
// 그래서 종합 별점 = 신뢰도 별점이다. 별도 가중 평균을 만들면 점수에 기여하지 않는
// 값이 "확신"으로 표시되는 거짓말이 된다.
//
// **수식을 옮겨 적지 않고 표시 스케일을 StarRating과 공유한다** (점수 계산기와 같은
// 원칙: 같은 값이 화면마다 다른 별 개수로 보이면 어느 쪽이 맞는지 사용자가 판단해야 한다).

export function convictionStars(
  assetClass: string | null,
  confidence: number | null,
  /** @deprecated v4에서 점수 기여 없음 — 호출부 정리 전까지 인자만 유지 */
  _stability?: number | null,
): number | null {
  void _stability;
  if (!assetClass || confidence === null) return null;
  return confidenceStars(confidence);
}
