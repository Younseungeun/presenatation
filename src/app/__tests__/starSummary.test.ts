import { describe, expect, it } from "vitest";
import { confidenceStars } from "../StarRating";
import { convictionStars } from "../starSummary";

// 함의 승률 별점 — 다이얼값이 정직하려면 걸어야 하는 최소 확률 × 5 (StarRating 주석).
describe("함의 승률 매핑", () => {
  it("신뢰도: c/(c+1) × 5 — 최소 신고도 승률 50%를 함의하므로 별 2.5부터 시작", () => {
    expect(confidenceStars(1)).toBeCloseTo(2.5, 10);
    expect(confidenceStars(3)).toBeCloseTo(3.75, 10);
    expect(confidenceStars(5)).toBeCloseTo((5 * 5) / 6, 10);
    expect(confidenceStars(10)).toBeCloseTo(50 / 11, 10);
  });

  it("별 5개(승률 100%)는 도달 불가 — 정직한 천장", () => {
    expect(confidenceStars(10)).toBeLessThan(5);
  });

  it("위로 갈수록 촘촘해진다 — 한 단계의 별 증가폭이 단조 감소", () => {
    for (let v = 2; v < 10; v++) {
      expect(confidenceStars(v + 1) - confidenceStars(v)).toBeLessThan(
        confidenceStars(v) - confidenceStars(v - 1),
      );
    }
  });
});

// 확신 종합 별점 v4 — 점수에 기여하는 자기 신고 다이얼은 신뢰도뿐이므로
// 종합 = 신뢰도 별점이다. 안정성을 섞으면 점수에 기여하지 않는 값이 "확신"으로
// 표시되는 거짓말이 된다 (starSummary 주석 참조).

describe("convictionStars (v4)", () => {
  it("종합 별점 = 신뢰도 별점", () => {
    expect(convictionStars("KR_EQUITY", 10, 10)).toBeCloseTo(confidenceStars(10), 10);
    expect(convictionStars("CRYPTO", 3, 1)).toBeCloseTo(confidenceStars(3), 10);
  });

  it("안정성 값은 결과에 영향이 없다 (deprecated 인자)", () => {
    expect(convictionStars("KR_EQUITY", 5, 1)).toBe(convictionStars("KR_EQUITY", 5, 10));
  });

  it("만점 카드도 별 5개에 닿지 않는다 — 승률 100%는 없다", () => {
    expect(convictionStars("KR_EQUITY", 10, 10)!).toBeLessThan(5);
    expect(convictionStars("KR_EQUITY", 10, 10)!).toBeGreaterThan(4.5);
  });

  it("자산군이 없으면 null", () => {
    expect(convictionStars(null, 5, 5)).toBeNull();
  });
});
