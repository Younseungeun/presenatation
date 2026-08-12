import { describe, expect, it } from 'vitest';
import { compositeStars, profitabilityPayoutStars } from '@/domain/ratingStars';
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
    stability: null,
    confidence: 6,
    deadline: new Date(NOW.getTime() + 5 * DAY),
    salesCount: 0,
    publishedAt: new Date(NOW.getTime() - 2 * DAY),
    ...over,
  };
}

describe('별점 평균 — 수익성·신뢰도를 점수 기여 가중(0.21 : 0.79)으로 합친다', () => {
  it('순위표에 뜨는 확신 종합 별점과 같은 값이다 — 정렬과 표시가 갈라지면 안 된다', () => {
    const c = card({ profitability: 3, confidence: 8 });
    expect(ratingAverage(c)).toBe(
      compositeStars({ profitability: c.profitability, confidence: c.confidence }),
    );
  });

  it('신뢰도 별은 카드 표시와 같은 함의 승률 스케일(5c/(c+1))로 들어간다', () => {
    // 수익성 구간3 → 버는 크기 별 2.689 / 신뢰도 8 → 별 40/9≈4.444
    // → 0.21·2.689 + 0.79·4.444 ≈ 4.076
    expect(ratingAverage(card({ profitability: 3, confidence: 8 }))).toBeCloseTo(4.076, 2);
  });

  it('신뢰도가 무겁다 — 같은 한 칸 차이라도 신뢰도 쪽이 평균을 더 움직인다', () => {
    const base = ratingAverage(card({ profitability: 3, confidence: 3 }));
    const profUp = ratingAverage(card({ profitability: 4, confidence: 3 }));
    const confUp = ratingAverage(card({ profitability: 3, confidence: 6 })); // 별 3.75→4.29
    expect(confUp - base).toBeGreaterThan(profUp - base);
  });

  it('별 5개는 도달 불가 — 신뢰도 별의 상한(승률 100%)이 5 미만이라 평균도 그렇다', () => {
    const top = ratingAverage(card({ profitability: 5, confidence: 10 }));
    expect(top).toBeGreaterThan(4.5);
    expect(top).toBeLessThan(5);
  });

  it('일부만 있으면 있는 별만으로 (분모도 그 무게만)', () => {
    expect(ratingAverage(card({ profitability: 4, confidence: null }))).toBeCloseTo(
      profitabilityPayoutStars(4),
      10,
    );
  });

  it('안정성은 평균에 들어가지 않는다 — 점수 기여 0이면 무게도 0', () => {
    expect(ratingAverage(card({ stability: 5 }))).toBe(ratingAverage(card({ stability: null })));
  });

  it('값이 하나도 없으면 −1 — 0으로 두면 "별 0개" 카드와 섞인다', () => {
    expect(ratingAverage(card({ profitability: null, confidence: null }))).toBe(-1);
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
        card({ profitability: 5, confidence: 9 }), // 0.21·5 + 0.79·4.5 ≈ 4.60
        card({ profitability: 3, confidence: 3 }), // 0.21·3 + 0.79·3.75 ≈ 3.59
        card({ profitability: 1, confidence: 1 }), // 0.21·1 + 0.79·2.5 ≈ 2.19
        card({ profitability: null, confidence: null }),
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
