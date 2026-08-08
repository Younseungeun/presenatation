import { describe, expect, it } from 'vitest';
import { groupCards, type MarketCard } from '../marketQueries';

// 목록은 정렬 기준 그 자체로 구간을 나눈다.
// 임의 간격 눈금은 리듬처럼 보일 뿐 정보가 아니라서, 사용자가 방금 고른 정렬을 쓴다.

const NOW = new Date('2026-08-08T00:00:00Z');
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
    repurchaseRate: null,
    assetClass: 'CRYPTO',
    direction: 'UP',
    profitability: 3,
    confidence: 3,
    stability: 3,
    deadline: new Date(NOW.getTime() + 5 * DAY),
    salesCount: 0,
    publishedAt: new Date(NOW.getTime() - 2 * DAY),
    ...over,
  };
}

describe('마감 임박순 — 시간 구간', () => {
  it('오늘 / 이번 주 / 한 달 / 그 이후로 갈린다', () => {
    const groups = groupCards(
      [
        card({ deadline: new Date(NOW.getTime() + 0.5 * DAY) }),
        card({ deadline: new Date(NOW.getTime() + 3 * DAY) }),
        card({ deadline: new Date(NOW.getTime() + 20 * DAY) }),
        card({ deadline: new Date(NOW.getTime() + 200 * DAY) }),
      ],
      'DEADLINE',
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual([
      '오늘 마감',
      '이번 주 마감',
      '한 달 안에 마감',
      '그 이후',
    ]);
    expect(groups.every((g) => g.cards.length === 1)).toBe(true);
  });

  it('같은 구간의 카드는 한 묶음으로 이어진다', () => {
    const groups = groupCards(
      [
        card({ deadline: new Date(NOW.getTime() + 2 * DAY) }),
        card({ deadline: new Date(NOW.getTime() + 3 * DAY) }),
        card({ deadline: new Date(NOW.getTime() + 4 * DAY) }),
      ],
      'DEADLINE',
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].cards).toHaveLength(3);
  });
});

describe('정렬마다 구간의 뜻이 다르다', () => {
  it('가격순은 가격대로 나눈다', () => {
    const groups = groupCards(
      [card({ priceKrw: 5_000 }), card({ priceKrw: 20_000 }), card({ priceKrw: 50_000 })],
      'PRICE_ASC',
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['1만원 미만', '1만~3만원', '3만원 이상']);
  });

  it('인기순은 구매 인원으로 나눈다', () => {
    const groups = groupCards(
      [card({ salesCount: 12 }), card({ salesCount: 4 }), card({ salesCount: 1 }), card()],
      'POPULAR',
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual([
      '10명 이상이 산 카드',
      '3명 이상이 산 카드',
      '구매가 있는 카드',
      '아직 첫 구매 전',
    ]);
  });

  it('등급순은 등급 이름으로 나눈다 — 무표기도 문장에서는 이름이 있다', () => {
    const groups = groupCards(
      [card({ tier: 'GOLD' }), card({ tier: 'BRONZE' })],
      'TIER',
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['마스터 리서처', '무표기 리서처']);
  });

  it('목표 크기순은 수익성 구간으로 나눈다', () => {
    const groups = groupCards(
      [card({ profitability: 5 }), card({ profitability: 1 }), card({ profitability: null })],
      'SIZE_DESC',
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['수익성 초공격', '수익성 소폭', '목표 미상']);
  });

  it('최신순은 게시 시점으로 나눈다', () => {
    const groups = groupCards(
      [
        card({ publishedAt: new Date(NOW.getTime() - 0.2 * DAY) }),
        card({ publishedAt: new Date(NOW.getTime() - 3 * DAY) }),
        card({ publishedAt: new Date(NOW.getTime() - 40 * DAY) }),
      ],
      'NEW',
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual([
      '오늘 올라온 카드',
      '이번 주에 올라온 카드',
      '그 이전',
    ]);
  });
});

describe('제목이 정보가 아닐 때는 붙이지 않는다', () => {
  it('구간이 하나뿐이면 제목이 빈 문자열 (화면이 줄을 그리지 않는다)', () => {
    const groups = groupCards([card(), card(), card()], 'DEADLINE', NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('');
    expect(groups[0].cards).toHaveLength(3);
  });

  it('빈 목록은 빈 결과', () => {
    expect(groupCards([], 'DEADLINE', NOW)).toEqual([]);
  });
});

describe('묶어도 카드는 하나도 잃지 않는다', () => {
  it('모든 정렬에서 카드 총합이 보존된다', () => {
    const cards = [
      card({ priceKrw: 5_000, salesCount: 11, tier: 'GOLD', profitability: 5 }),
      card({ priceKrw: 20_000, salesCount: 4, tier: 'SILVER', profitability: 3 }),
      card({ priceKrw: 90_000, salesCount: 0, tier: 'BRONZE', profitability: 1 }),
    ];
    for (const sort of ['DEADLINE', 'NEW', 'POPULAR', 'PRICE_ASC', 'TIER', 'SIZE_DESC'] as const) {
      const total = groupCards(cards, sort, NOW).reduce((n, g) => n + g.cards.length, 0);
      expect(total).toBe(cards.length);
    }
  });
});
