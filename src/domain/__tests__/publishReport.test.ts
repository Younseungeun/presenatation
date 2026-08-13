import { describe, expect, it } from 'vitest';
import {
  LONG_HORIZON_DAYS,
  MAX_ACTIVE_CARDS,
  MAX_ACTIVE_LONG_CARDS,
  preparePublish,
  REPORT_TEXT_LIMITS,
  validateCardDraft,
  validateConditions,
  validateReportText,
  type CardDraft,
  type PublishConditions,
} from '../publishReport';
import { minMagnitudePct } from '../scoring';

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
  // 크기 하한이 종목 변동성으로 정해지므로 픽스처도 σ를 명시한다 — 조용한 종목(0.5%/일).
  // 비워 두면 자산군 평균으로 물러서는데, 그 상수가 바뀌면 하한과 무관한 테스트가 깨진다
  sigmaDaily: 0.005,
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

  it('크기 하한은 **종목 변동성**으로 정해진다 — 거친 종목일수록 더 큰 크기를 요구한다', () => {
    // 같은 기간(92일)·같은 크기(10%)라도 종목이 거칠면 거부된다.
    // 저절로 닿을 크기를 예측으로 팔 수 없게 하는 것이 하한의 목적이기 때문
    const floorAt = (sigmaDaily: number) =>
      minMagnitudePct('KR_EQUITY', sigmaDaily, 92);

    expect(validateCardDraft({ ...validCard, targetValue: 10 }, NOW)).toEqual([]);
    expect(floorAt(0.005)).toBeLessThan(10);

    const wild = { ...validCard, sigmaDaily: 0.04 };
    expect(floorAt(0.04)).toBeGreaterThan(10);
    expect(validateCardDraft({ ...wild, targetValue: 10 }, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...wild, targetValue: floorAt(0.04) + 0.1 }, NOW)).toEqual([]);
  });

  it('σ가 없으면 자산군 평균으로 물러선다 — 검증이 멈추지 않는다', () => {
    const noSigma = { ...validCard, sigmaDaily: null, targetValue: 10 };
    // KR σ̄=2%, 92일 → 하한 약 23% → 10%는 거부된다
    expect(validateCardDraft(noSigma, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...noSigma, targetValue: 25 }, NOW)).toEqual([]);
  });

  // 종목 유니버스·하락 예측 제한은 종목 마스터(DB) 검증으로 이동 — instrumentService.test.ts

  it('신뢰도·안정성·수익성 자기 평가는 1~10 정수', () => {
    expect(validateCardDraft({ ...validCard, confidence: 11 }, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...validCard, confidence: 10 }, NOW)).toEqual([]);
    expect(validateCardDraft({ ...validCard, selfStability: 0 }, NOW)).not.toEqual([]);
  });
});

describe('validateReportText — 글자 수 상한 (검수 입력 토큰 상한과 연동)', () => {
  const text = { title: '제목', summary: '요약', content: '본문' };

  it('상한 이내는 통과', () => {
    expect(validateReportText(text)).toEqual([]);
    expect(
      validateReportText({ ...text, content: '가'.repeat(REPORT_TEXT_LIMITS.content) }),
    ).toEqual([]);
  });

  it('본문 1,000자 초과는 거부', () => {
    const issues = validateReportText({
      ...text,
      content: '가'.repeat(REPORT_TEXT_LIMITS.content + 1),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('본문');
    expect(issues[0]).toContain('1000자');
  });

  it('요약·제목도 상한이 있다 (요약은 검수 입력에 포함되므로)', () => {
    expect(
      validateReportText({ ...text, summary: '가'.repeat(REPORT_TEXT_LIMITS.summary + 1) })[0],
    ).toContain('요약');
    expect(
      validateReportText({ ...text, title: '가'.repeat(REPORT_TEXT_LIMITS.title + 1) })[0],
    ).toContain('제목');
  });

  it('공백만 있는 입력은 거부', () => {
    expect(validateReportText({ ...text, content: '   ' })[0]).toContain('본문');
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

  it('동시 활성 카드 상한: 브론즈 5건 도달 시 게시 거부, 등급이 오르면 슬롯 확대', () => {
    expect(() =>
      preparePublish(validCard, { ...validCond, activeCardCount: 5 }, 70_000, NOW),
    ).toThrow(/동시 활성 카드/);
    // 상한 미만이면 통과
    expect(
      preparePublish(validCard, { ...validCond, activeCardCount: 4 }, 70_000, NOW).feeRateBp,
    ).toBe(2000);
    // 실버는 7건까지 — 같은 5건도 통과
    expect(
      preparePublish(
        validCard,
        { ...validCond, tier: 'SILVER', activeCardCount: 5 },
        70_000,
        NOW,
      ).feeRateBp,
    ).toBe(1500);
  });

  it('장기 카드 슬롯: 시한 90일 초과는 활성 상한의 절반까지만', () => {
    // validCard는 시한 92일 = 장기 카드. 무표기 상한 5건의 절반 → 2건
    expect(MAX_ACTIVE_LONG_CARDS.BRONZE).toBe(2);
    expect(() =>
      preparePublish(validCard, { ...validCond, activeLongCardCount: 2 }, 70_000, NOW),
    ).toThrow(new RegExp(`시한 ${LONG_HORIZON_DAYS}일 초과`));
    expect(
      preparePublish(validCard, { ...validCond, activeLongCardCount: 1 }, 70_000, NOW).feeRateBp,
    ).toBe(2000);
  });

  it('단기 카드는 장기 슬롯이 차 있어도 낼 수 있다 — 회전이 계속돼야 증거가 쌓인다', () => {
    const short = { ...validCard, deadline: new Date('2026-08-12T00:00:00Z') }; // 31일
    expect(
      preparePublish(short, { ...validCond, activeLongCardCount: 99 }, 70_000, NOW).feeRateBp,
    ).toBe(2000);
  });

  it('장기 슬롯은 활성 상한에서 유도된다 — 두 곳에 적어 두면 갈라진다', () => {
    for (const [tier, n] of Object.entries(MAX_ACTIVE_CARDS)) {
      expect(MAX_ACTIVE_LONG_CARDS[tier as keyof typeof MAX_ACTIVE_CARDS]).toBe(
        Math.max(1, Math.floor(n / 2)),
      );
    }
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
    // 기준가 70,000 → 목표가 71,000 = 1.4% (σ 0.5%·92일의 하한 약 5.8% 미만)
    const card: CardDraft = { ...validCard, targetType: 'TARGET_PRICE', targetValue: 71_000 };
    expect(() => preparePublish(card, validCond, 70_000, NOW)).toThrow(/예측 크기 하한/);
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
