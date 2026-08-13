import { describe, expect, it } from 'vitest';
import {
  compositeStars,
  confidenceStars,
  profitabilityPayoutStars,
  RATING_WEIGHT,
} from '../ratingStars';
import { CONFIDENCE_RANGE, confidenceOddsMultiple, SCORE_MODEL_NAME } from '../scoring';

// 별점은 **인투빌 점수 산정 모델 vmax에서 유도된다.** 손으로 적은 상수가 하나라도
// 있으면 모델을 고칠 때 화면만 옛 눈금으로 남는다 — 그때 "별점 높은 순"이
// "점수를 크게 움직이는 순"을 더 이상 뜻하지 않게 된다.

describe('모델 이름은 한 곳에서만 나온다', () => {
  it('화면 문구가 읽는 이름이 확정값이다', () => {
    expect(SCORE_MODEL_NAME).toBe('인투빌 점수 산정 모델 vmax');
  });
});

describe('신뢰도 별 — 사다리가 등비라 별이 c에 선형이다', () => {
  it('하한이 ★1, 상한이 ★5', () => {
    expect(confidenceStars(CONFIDENCE_RANGE.min)).toBe(1);
    expect(confidenceStars(CONFIDENCE_RANGE.max)).toBe(5);
  });

  it('별 한 칸이 어느 구간에서든 같은 승산 배수를 뜻한다', () => {
    // 이것이 "별이 선형"의 실제 내용이다 — 깨지면 ★1→★2와 ★4→★5가 다른 뜻이 된다
    const step = (c: number) => confidenceOddsMultiple(c + 2) / confidenceOddsMultiple(c);
    expect(step(2)).toBeCloseTo(step(8), 10);
  });

  it('범위 밖은 클램프된다 — 폐지된 c=1이 ★0으로 새어 나가지 않게', () => {
    expect(confidenceStars(1)).toBe(1);
    expect(confidenceStars(99)).toBe(5);
  });
});

describe('수익성 별 — 구간 번호가 아니라 버는 크기', () => {
  it('대표 배수의 로그를 1~5로 편다', () => {
    expect(profitabilityPayoutStars(1)).toBeCloseTo(1, 10);
    expect(profitabilityPayoutStars(5)).toBeCloseTo(5, 10);
    // 구간 폭이 고르지 않아 번호를 그대로 쓰면 위쪽이 눌린다 — 중간이 3이 아니다
    expect(profitabilityPayoutStars(3)).not.toBeCloseTo(3, 2);
  });

  it('단조 증가 — 크게 걸수록 별이 높다', () => {
    const s = ([1, 2, 3, 4, 5] as const).map(profitabilityPayoutStars);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
  });
});

describe('융합 별점의 가중치는 모델에서 유도된다', () => {
  it('두 축의 칸당 로그 기울기 비율 — 손으로 적은 값이 아니다', () => {
    // 수익성 가중 w는 구간 1→5에서 1.00 → 2.00 (scoring.magnitudeWeight)
    const expectedProfit = Math.log(2) / (profitabilityPayoutStars(5) - profitabilityPayoutStars(1));
    const expectedConf =
      Math.log(
        confidenceOddsMultiple(CONFIDENCE_RANGE.max) / confidenceOddsMultiple(CONFIDENCE_RANGE.min),
      ) /
      (confidenceStars(CONFIDENCE_RANGE.max) - confidenceStars(CONFIDENCE_RANGE.min));
    const total = expectedProfit + expectedConf;
    expect(RATING_WEIGHT.profitability).toBeCloseTo(expectedProfit / total, 12);
    expect(RATING_WEIGHT.confidence).toBeCloseTo(expectedConf / total, 12);
  });

  it('현재 값 (vmax 확정, 2026-08-13)', () => {
    expect(RATING_WEIGHT.profitability).toBeCloseTo(0.136, 3);
    expect(RATING_WEIGHT.confidence).toBeCloseTo(0.864, 3);
    expect(RATING_WEIGHT.profitability + RATING_WEIGHT.confidence).toBeCloseTo(1, 12);
  });

  it('신뢰도가 무겁다 — 정보량의 부호를 정하는 축이라 그래야 한다', () => {
    expect(RATING_WEIGHT.confidence).toBeGreaterThan(RATING_WEIGHT.profitability * 5);
  });
});

describe('융합 별점 — 평균 별점의 원천', () => {
  it('한쪽만 있으면 그 별 그대로 (분모도 그 무게만)', () => {
    expect(compositeStars({ profitability: 3, confidence: null })).toBeCloseTo(
      profitabilityPayoutStars(3),
      10,
    );
    expect(compositeStars({ profitability: null, confidence: 6 })).toBeCloseTo(
      confidenceStars(6),
      10,
    );
  });

  it('둘 다 없으면 null — 별이 없는 것과 ★0은 다르다', () => {
    expect(compositeStars({ profitability: null, confidence: null })).toBeNull();
  });

  it('가중 평균이라 신뢰도 쪽으로 크게 끌린다', () => {
    // 수익성 ★5 + 신뢰도 ★1이면 산술평균은 3이지만, 무게가 0.136/0.864라 1에 가깝다
    const v = compositeStars({ profitability: 5, confidence: CONFIDENCE_RANGE.min })!;
    expect(v).toBeLessThan(2);
    expect(v).toBeCloseTo(5 * RATING_WEIGHT.profitability + 1 * RATING_WEIGHT.confidence, 10);
  });

  it('양 끝은 ★1과 ★5 — 눈금이 새어 나가지 않는다', () => {
    expect(compositeStars({ profitability: 1, confidence: CONFIDENCE_RANGE.min })).toBeCloseTo(1, 10);
    expect(compositeStars({ profitability: 5, confidence: CONFIDENCE_RANGE.max })).toBeCloseTo(5, 10);
  });
});
