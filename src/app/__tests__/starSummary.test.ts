import { describe, expect, it } from "vitest";
import { profitabilityPayoutStars } from "@/domain/ratingStars";
import { confidenceStars } from "../StarRating";
import { convictionStars } from "../starSummary";

// 함의 승률 별점 — 다이얼값이 정직하려면 걸어야 하는 최소 확률 × 5 (ratingStars 주석).
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

// 수익성 몫은 구간 번호가 아니라 **적중 시 버는 크기**로 환산해 넣는다 —
// 구간 폭이 고르지 않아(1.5F 폭 vs 2F 폭) 번호를 그대로 쓰면 위 구간 값이 눌린다.
describe("수익성 → 버는 크기 별점", () => {
  it("양 끝은 별 1과 5에 고정된다", () => {
    expect(profitabilityPayoutStars(1)).toBeCloseTo(1, 10);
    expect(profitabilityPayoutStars(5)).toBeCloseTo(5, 10);
  });

  it("위로 갈수록 한 칸의 값이 커진다 — 구간 4→5가 가장 큰 도약", () => {
    const gaps = [2, 3, 4, 5].map(
      (l) => profitabilityPayoutStars(l as 2 | 3 | 4 | 5) - profitabilityPayoutStars((l - 1) as 1 | 2 | 3 | 4),
    );
    expect(gaps[3]).toBeGreaterThan(gaps[0]);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);
  });

  it("구간 번호보다 낮게 앉는다 — 아래 구간이 좁아 값이 덜 오른다", () => {
    expect(profitabilityPayoutStars(2)).toBeLessThan(2);
    expect(profitabilityPayoutStars(4)).toBeLessThan(4);
  });
});

// 확신 종합 별점 — 수익성(맞으면 얼마나 버나) 0.21 + 신뢰도(얼마나 맞나) 0.79.
// 안정성은 섞지 않는다: 점수 기여가 0이고, 이 별은 리서처가 건 확신의 요약이다.
describe("convictionStars — 점수 기여 가중", () => {
  it("두 축의 가중 평균이다", () => {
    const stars = convictionStars("KR_EQUITY", 6, 3)!;
    expect(stars).toBeCloseTo(
      0.21 * profitabilityPayoutStars(3) + 0.79 * confidenceStars(6),
      10,
    );
  });

  it("신뢰도가 무겁다 — 같은 한 칸이라도 신뢰도 쪽이 종합을 더 움직인다", () => {
    const base = convictionStars("KR_EQUITY", 3, 3)!;
    const profUp = convictionStars("KR_EQUITY", 3, 4)!;
    const confUp = convictionStars("KR_EQUITY", 6, 3)!; // 별 3.75 → 4.29
    expect(confUp - base).toBeGreaterThan(profUp - base);
  });

  it("수익성이 없으면 신뢰도만으로 (분모도 그 무게만)", () => {
    expect(convictionStars("CRYPTO", 3)).toBeCloseTo(confidenceStars(3), 10);
  });

  it("만점 카드도 별 5개에 닿지 않는다 — 승률 100%는 없다", () => {
    const top = convictionStars("KR_EQUITY", 10, 5)!;
    expect(top).toBeLessThan(5);
    expect(top).toBeGreaterThan(4.5);
  });

  it("자산군이 없으면 null", () => {
    expect(convictionStars(null, 5, 5)).toBeNull();
  });
});
