import { describe, expect, it } from 'vitest';
import {
  groupCards,
  hasActiveFilter,
  MARKET_SORTS,
  MARKET_SORT_LABEL,
  ratingAverage,
  type MarketCard,
} from '../marketQueries';

// 필터·별점 정렬. 정렬이 순서를 바꾼다면 필터는 후보를 줄인다.

const NOW = new Date('2026-08-09T00:00:00Z');
const DAY = 86_400_000;

function card(over: Partial<MarketCard> = {}): MarketCard {
  return {
    reportId: Math.random().toString(36).slice(2),
    priceKrw: 12_000,
    prepaymentRatio: 0,
    researcherId: 'r1',
    researcherName: '리서처',
    tier: 'BRONZE',
    careerBadge: null,
    hitRate: null,
    judgedCount: 0,
    repurchaseRate: null,
    assetClass: 'CRYPTO',
    direction: 'UP',
    profitability: 3,
    confidence: 6,
    stability: 6,
    deadline: new Date(NOW.getTime() + 5 * DAY),
    salesCount: 0,
    publishedAt: new Date(NOW.getTime() - 2 * DAY),
    ...over,
  };
}

describe('별점 평균 — 카드에 뜨는 별 셋의 평균', () => {
  it('신뢰도·안정성은 1~10이라 반으로 접는다 (화면 표기와 같은 환산)', () => {
    // 수익성 3 / 안정성 6→3 / 신뢰도 8→4 → 평균 3.33
    expect(ratingAverage(card({ profitability: 3, stability: 6, confidence: 8 }))).toBeCloseTo(
      10 / 3,
      2,
    );
  });

  it('만점은 5', () => {
    expect(ratingAverage(card({ profitability: 5, stability: 10, confidence: 10 }))).toBe(5);
  });

  it('일부만 있으면 있는 값끼리 평균 낸다', () => {
    expect(ratingAverage(card({ profitability: 4, stability: null, confidence: null }))).toBe(4);
  });

  it('값이 하나도 없으면 −1 — 0으로 두면 "별 0개" 카드와 섞인다', () => {
    expect(
      ratingAverage(card({ profitability: null, stability: null, confidence: null })),
    ).toBe(-1);
  });
});

describe('별점 정렬', () => {
  it('정렬 목록과 라벨에 등록돼 있다', () => {
    expect(MARKET_SORTS).toContain('RATING_DESC');
    expect(MARKET_SORT_LABEL.RATING_DESC).toBe('별점 높은 순');
  });

  it('구간은 4점 이상 / 3점대 / 그 미만 / 미상으로 갈린다', () => {
    const groups = groupCards(
      [
        card({ profitability: 5, stability: 9, confidence: 9 }), // 4.75
        card({ profitability: 3, stability: 7, confidence: 7 }), // 3.33
        card({ profitability: 1, stability: 2, confidence: 2 }), // 1.0
        card({ profitability: null, stability: null, confidence: null }),
      ],
      'RATING_DESC',
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual([
      '별점 4점 이상',
      '별점 3점대',
      '별점 3점 미만',
      '별점 미상',
    ]);
  });
});

describe('필터 활성 판정', () => {
  it('아무것도 안 걸려 있으면 false', () => {
    expect(hasActiveFilter({})).toBe(false);
    expect(hasActiveFilter({ refundOnly: false, maxPriceKrw: null, withinDays: null })).toBe(
      false,
    );
  });

  it('축 하나만 걸려도 true — 화면이 "필터 해제"를 띄우는 기준', () => {
    expect(hasActiveFilter({ refundOnly: true })).toBe(true);
    expect(hasActiveFilter({ maxPriceKrw: 10_000 })).toBe(true);
    expect(hasActiveFilter({ withinDays: 7 })).toBe(true);
  });
});

describe('판매 많은 순 라벨', () => {
  it('"인기순"이 아니라 "판매 많은 순" — 무엇이 많은지 말한다', () => {
    expect(MARKET_SORT_LABEL.POPULAR).toBe('판매 많은 순');
  });
});
