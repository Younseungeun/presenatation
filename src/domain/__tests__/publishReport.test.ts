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
  selfStability: 5,
  selfProfitability: 7,
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

  it('주식은 단기(당일 포함) 초안 허용 — 컷오프 규칙은 게시 시점에 검증. 최대 365일', () => {
    const us = { ...validCard, assetClass: 'US_EQUITY' as const, ticker: 'AAPL' };
    expect(validateCardDraft({ ...us, deadline: new Date('2026-07-15') }, NOW)).toEqual([]);
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

  it('자산군별 크기 하한: 주식 5%, 코인 10% 미만의 수익률형 예측 거부', () => {
    expect(validateCardDraft({ ...validCard, targetValue: 4.9 }, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...validCard, targetValue: 5 }, NOW)).toEqual([]);
    const crypto = { ...validCard, assetClass: 'CRYPTO' as const, ticker: 'KRW-BTC' };
    expect(validateCardDraft({ ...crypto, targetValue: 9 }, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...crypto, targetValue: 10 }, NOW)).toEqual([]);
  });

  it('하락 예측은 숏 실행 수단이 있는 종목만: KR 개별주식선물·US 인버스 ETF 유니버스', () => {
    // KR: 삼성전자(선물 상장)는 허용, 잡주(가상의 6자리 코드)는 거부
    expect(validateCardDraft({ ...validCard, direction: 'DOWN' }, NOW)).toEqual([]);
    const krMinor = { ...validCard, ticker: '123456', assetName: '잡주' };
    expect(validateCardDraft({ ...krMinor, direction: 'DOWN' }, NOW).join()).toMatch(/개별주식선물/);
    expect(validateCardDraft(krMinor, NOW)).toEqual([]); // 상승 예측은 제한 없음

    // US: TSLA(인버스 ETF 존재)는 허용, 소형주는 거부
    const us = { ...validCard, assetClass: 'US_EQUITY' as const, assetName: 'x' };
    expect(validateCardDraft({ ...us, ticker: 'TSLA', direction: 'DOWN' }, NOW)).toEqual([]);
    expect(
      validateCardDraft({ ...us, ticker: 'XYZQ', direction: 'DOWN' }, NOW).join(),
    ).toMatch(/인버스/);
    expect(validateCardDraft({ ...us, ticker: 'XYZQ' }, NOW)).toEqual([]);

    // 코인은 선물·마진으로 어느 종목이든 숏 가능 → 제한 없음
    const crypto = { ...validCard, assetClass: 'CRYPTO' as const, ticker: 'KRW-XRP', targetValue: 15 };
    expect(validateCardDraft({ ...crypto, direction: 'DOWN' }, NOW)).toEqual([]);
  });

  it('신뢰도·안정성·수익성 자기 평가는 1~10 정수', () => {
    expect(validateCardDraft({ ...validCard, confidence: 11 }, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...validCard, confidence: 10 }, NOW)).toEqual([]);
    expect(validateCardDraft({ ...validCard, selfStability: 0 }, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...validCard, selfProfitability: 5.5 }, NOW)).not.toEqual([]);
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
      validateConditions({ ...validCond, tier: 'GOLD', prepaymentRatio: 10 }),
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

  it('KR 단기 카드: 장 시작 후 게시는 당일·익일 시한 거부, +2일부터 허용 (기준가 = 게시일 종가)', () => {
    // KST 2026-07-13(월) 09:00 — 장중
    const monOpen = new Date('2026-07-13T00:00:00Z');
    const sameDay: CardDraft = { ...validCard, deadline: new Date('2026-07-13T06:30:00Z') };
    expect(() => preparePublish(sameDay, validCond, null, monOpen)).toThrow(/2일/);

    const nextDay: CardDraft = { ...validCard, deadline: new Date('2026-07-14T06:30:00Z') };
    expect(() => preparePublish(nextDay, validCond, null, monOpen)).toThrow(/2일/);

    const twoDays: CardDraft = { ...validCard, deadline: new Date('2026-07-15T06:30:00Z') };
    const snap = preparePublish(twoDays, validCond, null, monOpen);
    expect(snap.baseMode).toBe('DAY_CLOSE_AT_JUDGMENT');
    expect(snap.basePrice).toBeNull();
  });

  it('KR 단기 카드: 주말 게시도 +2일부터 허용 (기준가 = 다음 거래일 종가)', () => {
    // KST 2026-07-12(일) 07:00
    const sunPreOpen = new Date('2026-07-11T22:00:00Z');
    const monDeadline: CardDraft = { ...validCard, deadline: new Date('2026-07-13T06:30:00Z') };
    expect(() => preparePublish(monDeadline, validCond, null, sunPreOpen)).toThrow(/2일/);

    const tueDeadline: CardDraft = { ...validCard, deadline: new Date('2026-07-14T06:30:00Z') };
    expect(preparePublish(tueDeadline, validCond, null, sunPreOpen).baseMode).toBe(
      'DAY_CLOSE_AT_JUDGMENT',
    );
  });

  it('US 단기 카드: 당일 창구 없음 — 새벽(프리마켓 전)에도 당일·익일 시한 거부', () => {
    // ET 2026-07-13(월) 03:00 = UTC 07:00 — 주간거래(오버나이트 ATS)가 진행 중인 시각
    const monPrePremarket = new Date('2026-07-13T07:00:00Z');
    const us = { ...validCard, assetClass: 'US_EQUITY' as const, ticker: 'AAPL' };
    expect(() =>
      preparePublish(
        { ...us, deadline: new Date('2026-07-13T20:00:00Z') }, // 당일 16:00 ET
        validCond,
        null,
        monPrePremarket,
      ),
    ).toThrow(/주간거래/);
  });

  it('US 단기 카드: 언제 게시하든 +2일부터, 기준가 = 게시 이후 첫 종가', () => {
    // ET 2026-07-13(월) 14:00 = UTC 18:00 — 정규장 장중
    const monDayMarket = new Date('2026-07-13T18:00:00Z');
    const us = { ...validCard, assetClass: 'US_EQUITY' as const, ticker: 'AAPL' };

    expect(() =>
      preparePublish({ ...us, deadline: new Date('2026-07-14T20:00:00Z') }, validCond, null, monDayMarket),
    ).toThrow(/2일/);

    const snap = preparePublish(
      { ...us, deadline: new Date('2026-07-15T20:00:00Z') },
      validCond,
      null,
      monDayMarket,
    );
    expect(snap.baseMode).toBe('DAY_CLOSE_AT_JUDGMENT');
  });

  it('KR 장기 카드(7일 이상)는 기존대로 게시 시점 기준가 확정', () => {
    const snap = preparePublish(validCard, validCond, 70_000, NOW);
    expect(snap.baseMode).toBe('FIXED_AT_PUBLISH');
    expect(snap.basePrice).toBe(70_000);
  });

  it('목표가형: 기준가 대비 크기가 하한 미만이면 게시 거부', () => {
    // 기준가 70,000 → 목표가 71,000 = 1.4% (< KR 5%)
    const card: CardDraft = { ...validCard, targetType: 'TARGET_PRICE', targetValue: 71_000 };
    expect(() => preparePublish(card, validCond, 70_000, NOW)).toThrow(/최소 5%/);
  });

  it('기준가 소급 확정 단기 카드는 수익률형만 허용 (목표가형 거부)', () => {
    const monPreOpen = new Date('2026-07-12T22:00:00Z'); // KST 월 07:00
    const card: CardDraft = {
      ...validCard,
      targetType: 'TARGET_PRICE',
      targetValue: 80_000,
      deadline: new Date('2026-07-13T06:30:00Z'),
    };
    expect(() => preparePublish(card, validCond, null, monPreOpen)).toThrow(/수익률형/);
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
