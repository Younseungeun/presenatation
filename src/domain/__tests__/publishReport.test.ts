import { describe, expect, it } from 'vitest';
import {
  preparePublish,
  validateCardDraft,
  validateConditions,
  type CardDraft,
  type PublishConditions,
} from '../publishReport';

const NOW = new Date('2026-07-12T00:00:00Z');

const validCard: CardDraft = {
  assetClass: 'KR_EQUITY',
  ticker: '005930',
  assetName: '삼성전자',
  direction: 'UP',
  targetType: 'RETURN_PCT',
  targetValue: 10,
  deadline: new Date('2026-10-12T00:00:00Z'),
  confidence: 3,
};

const validCond: PublishConditions = {
  priceKrw: 20_000,
  prepaymentRatio: 0,
  tier: 'BRONZE',
  promoActive: false,
};

describe('validateCardDraft', () => {
  it('정상 카드는 이슈 없음', () => {
    expect(validateCardDraft(validCard, NOW)).toEqual([]);
  });

  it('자산군별 티커 형식 검증', () => {
    expect(validateCardDraft({ ...validCard, ticker: 'AAPL' }, NOW)).not.toEqual([]);
    expect(
      validateCardDraft({ ...validCard, assetClass: 'US_EQUITY', ticker: 'AAPL' }, NOW),
    ).toEqual([]);
    expect(
      validateCardDraft({ ...validCard, assetClass: 'US_EQUITY', ticker: 'BRK.B' }, NOW),
    ).toEqual([]);
    expect(
      validateCardDraft({ ...validCard, assetClass: 'CRYPTO', ticker: 'KRW-BTC' }, NOW),
    ).toEqual([]);
    expect(
      validateCardDraft({ ...validCard, assetClass: 'CRYPTO', ticker: 'BTC' }, NOW),
    ).not.toEqual([]);
  });

  it('미국주식은 검증 시한 최소 7일 (EOD 기준가 조작 방지), 최대 365일', () => {
    const us = { ...validCard, assetClass: 'US_EQUITY' as const, ticker: 'AAPL' };
    expect(validateCardDraft({ ...us, deadline: new Date('2026-07-15') }, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...us, deadline: new Date('2027-08-01') }, NOW)).not.toEqual([]);
  });

  it('국내주식은 단기(당일 포함) 초안 허용 — 게시 시점 컷오프 규칙은 별도', () => {
    expect(
      validateCardDraft({ ...validCard, deadline: new Date('2026-07-13T06:30:00Z') }, NOW),
    ).toEqual([]);
  });

  it('코인은 실시간 기준가 덕분에 1일 단타 예측 허용', () => {
    const crypto = {
      ...validCard,
      assetClass: 'CRYPTO' as const,
      ticker: 'KRW-BTC',
      deadline: new Date('2026-07-13T06:00:00Z'), // NOW + 1.25일
    };
    expect(validateCardDraft(crypto, NOW)).toEqual([]);
    // 1일 미만은 코인도 거부
    expect(
      validateCardDraft({ ...crypto, deadline: new Date('2026-07-12T12:00:00Z') }, NOW),
    ).not.toEqual([]);
  });

  it('확신도는 1~5', () => {
    expect(validateCardDraft({ ...validCard, confidence: 6 }, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...validCard, confidence: undefined }, NOW)).toEqual([]);
  });
});

describe('validateConditions', () => {
  it('가격 가이드(5천~5만원) 준수', () => {
    expect(validateConditions({ ...validCond, priceKrw: 4_999 })).not.toEqual([]);
    expect(validateConditions({ ...validCond, priceKrw: 50_001 })).not.toEqual([]);
    expect(validateConditions({ ...validCond, priceKrw: 5_000 })).toEqual([]);
  });

  it('등급이 허용하지 않는 선결제 비율 거부 (브론즈 + 10%)', () => {
    expect(validateConditions({ ...validCond, prepaymentRatio: 10 })).not.toEqual([]);
    expect(
      validateConditions({ ...validCond, tier: 'SILVER', prepaymentRatio: 10 }),
    ).toEqual([]);
  });
});

describe('preparePublish', () => {
  it('게시 스냅샷: 수수료·기준가·게시 시각 고정', () => {
    const snap = preparePublish(validCard, validCond, 70_000, NOW);
    expect(snap).toEqual({
      feeRateBp: 2000,
      baseMode: 'FIXED_AT_PUBLISH',
      basePrice: 70_000,
      publishedAt: NOW,
    });
  });

  it('프로모션 수수료 반영', () => {
    const snap = preparePublish(validCard, { ...validCond, promoActive: true }, 70_000, NOW);
    expect(snap.feeRateBp).toBe(1000);
  });

  it('기준가를 확정할 수 없으면 게시 실패', () => {
    expect(() => preparePublish(validCard, validCond, NaN, NOW)).toThrow(/기준가/);
    expect(() => preparePublish(validCard, validCond, 0, NOW)).toThrow(/기준가/);
  });

  it('상승 예측의 목표가가 기준가 이하이면 게시 실패', () => {
    const card: CardDraft = { ...validCard, targetType: 'TARGET_PRICE', targetValue: 65_000 };
    expect(() => preparePublish(card, validCond, 70_000, NOW)).toThrow(/목표가/);
  });

  it('하락 예측의 목표가가 기준가 이상이면 게시 실패', () => {
    const card: CardDraft = {
      ...validCard,
      direction: 'DOWN',
      targetType: 'TARGET_PRICE',
      targetValue: 75_000,
    };
    expect(() => preparePublish(card, validCond, 70_000, NOW)).toThrow(/목표가/);
  });

  it('KR 단기 카드: 평일 개장 전 게시 → 기준가 소급 확정 모드로 게시 성공', () => {
    // KST 2026-07-13(월) 07:00 — 동시호가(08:30) 전
    const monPreOpen = new Date('2026-07-12T22:00:00Z');
    const card: CardDraft = { ...validCard, deadline: new Date('2026-07-13T06:30:00Z') }; // 당일 15:30 KST
    const snap = preparePublish(card, validCond, null, monPreOpen);
    expect(snap.baseMode).toBe('PREV_CLOSE_AT_JUDGMENT');
    expect(snap.basePrice).toBeNull();
  });

  it('KR 단기 카드: 개장 후(08:30 KST 이후) 게시 거부', () => {
    // KST 2026-07-13(월) 09:00 — 장중
    const monOpen = new Date('2026-07-13T00:00:00Z');
    const card: CardDraft = { ...validCard, deadline: new Date('2026-07-13T06:30:00Z') };
    expect(() => preparePublish(card, validCond, null, monOpen)).toThrow(/개장 전/);
  });

  it('KR 단기 카드: 주말 게시 거부', () => {
    // KST 2026-07-12(일) 07:00
    const sunPreOpen = new Date('2026-07-11T22:00:00Z');
    const card: CardDraft = { ...validCard, deadline: new Date('2026-07-13T06:30:00Z') };
    expect(() => preparePublish(card, validCond, null, sunPreOpen)).toThrow(/거래일/);
  });

  it('KR 장기 카드(7일 이상)는 기존대로 게시 시점 기준가 확정', () => {
    const snap = preparePublish(validCard, validCond, 70_000, NOW);
    expect(snap.baseMode).toBe('FIXED_AT_PUBLISH');
    expect(snap.basePrice).toBe(70_000);
  });

  it('검증 이슈는 한 번에 모아서 보고', () => {
    try {
      preparePublish(
        { ...validCard, ticker: 'BAD', targetValue: -1 },
        { ...validCond, priceKrw: 100 },
        70_000,
        NOW,
      );
      expect.unreachable();
    } catch (e) {
      const issues = (e as { issues: string[] }).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
