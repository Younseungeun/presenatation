import { describe, expect, it } from "vitest";
import { confidenceStars, stabilityStars } from "../StarRating";
import { convictionStars, convictionWeights } from "../starSummary";

// 함의 승률 별점 — 다이얼값이 정직하려면 걸어야 하는 최소 확률 × 5 (StarRating 주석).
describe("함의 승률 매핑", () => {
  it("신뢰도: c/(c+1) × 5 — 최소 신고도 승률 50%를 함의하므로 별 2.5부터 시작", () => {
    expect(confidenceStars(1)).toBeCloseTo(2.5, 10);
    expect(confidenceStars(3)).toBeCloseTo(3.75, 10);
    expect(confidenceStars(5)).toBeCloseTo((5 * 5) / 6, 10);
    expect(confidenceStars(10)).toBeCloseTo(50 / 11, 10);
  });

  it("안정성: (s−1)/s × 5 — s=1은 배팅 불참이라 별 0", () => {
    expect(stabilityStars(1)).toBe(0);
    expect(stabilityStars(2)).toBeCloseTo(2.5, 10);
    expect(stabilityStars(5)).toBeCloseTo(4, 10);
    expect(stabilityStars(10)).toBeCloseTo(4.5, 10);
  });

  it("별 5개(승률 100%)는 도달 불가 — 정직한 천장", () => {
    expect(confidenceStars(10)).toBeLessThan(5);
    expect(stabilityStars(10)).toBeLessThan(5);
  });

  it("위로 갈수록 촘촘해진다 — 한 단계의 별 증가폭이 단조 감소", () => {
    for (let v = 2; v < 10; v++) {
      expect(confidenceStars(v + 1) - confidenceStars(v)).toBeLessThan(
        confidenceStars(v) - confidenceStars(v - 1),
      );
    }
  });
});

// 확신 종합 별점 — 가중치가 점수 모델 v3의 상수에서 유도되는지 못 박는다.
// 여기 수치가 바뀌었다면 scoring.ts의 상수가 바뀐 것이고, 그때 이 테스트는
// "화면 별점도 따라 바뀌었다"는 확인이 된다 (수식 복제 없음 — starSummary 주석 참조).

describe("convictionWeights", () => {
  it("주식: 신뢰도 500 : 안정성 450 (크기 하한 5%)", () => {
    const w = convictionWeights("KR_EQUITY");
    expect(w.confidence).toBeCloseTo(500 / 950, 10);
    expect(w.stability).toBeCloseTo(450 / 950, 10);
    expect(convictionWeights("US_EQUITY")).toEqual(w);
  });

  it("코인: 신뢰도 1000 : 안정성 450 (크기 하한 10%)", () => {
    const w = convictionWeights("CRYPTO");
    expect(w.confidence).toBeCloseTo(1000 / 1450, 10);
    expect(w.stability).toBeCloseTo(450 / 1450, 10);
  });

  it("가중치의 합은 자산군과 무관하게 1", () => {
    for (const asset of ["KR_EQUITY", "US_EQUITY", "CRYPTO"] as const) {
      const w = convictionWeights(asset);
      expect(w.confidence + w.stability).toBeCloseTo(1, 10);
    }
  });
});

describe("convictionStars", () => {
  it("가중 평균 — 개별 함의 승률 별점을 같은 가중치로 합친다", () => {
    const w = convictionWeights("KR_EQUITY");
    expect(convictionStars("KR_EQUITY", 10, 10)).toBeCloseTo(
      w.confidence * confidenceStars(10) + w.stability * stabilityStars(10),
      10,
    );
  });

  it("만점 카드도 별 5개에 닿지 않는다 — 승률 100%는 없다", () => {
    expect(convictionStars("KR_EQUITY", 10, 10)!).toBeLessThan(5);
    expect(convictionStars("KR_EQUITY", 10, 10)!).toBeGreaterThan(4.5);
  });

  it("최저 신고(1·1) = 신뢰도 함의 50%만 남는다 (안정성은 불참 0)", () => {
    const w = convictionWeights("KR_EQUITY");
    expect(convictionStars("KR_EQUITY", 1, 1)).toBeCloseTo(w.confidence * 2.5, 10);
  });

  it("코인은 신뢰도 쪽으로 더 기운다 — 같은 입력이라도 자산군별 가중이 다르다", () => {
    // 신뢰도만 높은 카드: 코인에서 별이 더 많아야 한다 (신뢰도 가중 69% > 52.6%)
    const equity = convictionStars("KR_EQUITY", 10, 2)!;
    const crypto = convictionStars("CRYPTO", 10, 2)!;
    expect(crypto).toBeGreaterThan(equity);
  });

  it("값이 없으면 null — 별 0개(최저 평가)와 미기재는 다른 상태다", () => {
    expect(convictionStars(null, 5, 5)).toBeNull();
    expect(convictionStars("KR_EQUITY", null, 5)).toBeNull();
    expect(convictionStars("KR_EQUITY", 5, null)).toBeNull();
    expect(convictionStars("UNKNOWN_ASSET", 5, 5)).toBeNull();
  });
});
