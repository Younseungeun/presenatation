import { describe, expect, it } from "vitest";
import { profitabilityPayoutStars, RATING_WEIGHT } from "@/domain/ratingStars";
import { CONFIDENCE_RANGE } from "@/domain/scoring";
import { confidenceStars } from "../StarRating";
import { convictionStars } from "../starSummary";

// 함의 승률 별점 — 다이얼값이 정직하려면 걸어야 하는 최소 확률 × 5 (ratingStars 주석).
describe("함의 승률 매핑", () => {
  it("쓸 수 있는 구간이 별 눈금을 다 쓴다 — 하한 신고가 ★1, 최대가 ★4.55", () => {
    // 예전에는 `승률 × 5`를 그대로 써서 c=1이 ★2.5였는데, 신뢰도 하한이 2로 오르면서
    // 그 자리가 죽었다. 그대로 뒀다면 실제 구간이 ★3.33~4.55에 몰려
    // "최소 신뢰도 카드가 5점 만점에 3.3점"으로 보였을 것이다
    expect(confidenceStars(CONFIDENCE_RANGE.min)).toBeCloseTo(1, 10);
    expect(confidenceStars(CONFIDENCE_RANGE.max)).toBeCloseTo(50 / 11, 10);
    // 순서는 여전히 함의 승률 순이다
    expect(confidenceStars(5)).toBeGreaterThan(confidenceStars(3));
  });

  it("별 5개(승률 100%)는 도달 불가 — 정직한 천장", () => {
    expect(confidenceStars(10)).toBeLessThan(5);
  });

  it("위로 갈수록 촘촘해진다 — 한 단계의 별 증가폭이 단조 감소", () => {
    for (let v = CONFIDENCE_RANGE.min + 1; v < CONFIDENCE_RANGE.max; v++) {
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
    // 무게는 상수가 아니라 점수 모델에서 유도된다(RATING_WEIGHT) — 숫자를 여기 적으면
    // 신뢰도 범위·별 스케일이 바뀔 때 테스트가 낡은 값을 지키게 된다
    const stars = convictionStars("KR_EQUITY", 6, 3)!;
    expect(stars).toBeCloseTo(
      RATING_WEIGHT.profitability * profitabilityPayoutStars(3) +
        RATING_WEIGHT.confidence * confidenceStars(6),
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
