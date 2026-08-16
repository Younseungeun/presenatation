import { describe, expect, it } from 'vitest';
import {
  EQUITY_SHORT_HORIZON_DAYS,
  LONG_HORIZON_DAYS,
  MAX_ACTIVE_CARDS,
  planBaseMode,
  MAX_ACTIVE_CARDS_TOTAL,
  MAX_ACTIVE_LONG_CARDS,
  NEW_RESEARCHER_MAX_HORIZON_DAYS,
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
  // 판정을 한 번은 받아 본 사람 — 대부분의 시험은 이 규칙의 대상이 아니다.
  // **기본값을 0(미검증)으로 두는 것이 안전한 쪽**이라 fixture에서 명시한다
  judgedCardCount: 1,
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

  it('σ가 없으면 **거친 쪽**으로 물러선다 — 검증이 멈추지 않고, 모르는 대가는 리서처가 진다', () => {
    const noSigma = { ...validCard, sigmaDaily: null, targetValue: 10 };
    // KR 폴백 7.05%(실측 상위 5분위), 92일 → 하한 약 81%
    const floor = minMagnitudePct('KR_EQUITY', null, 92);
    expect(floor).toBeGreaterThan(75);
    expect(validateCardDraft(noSigma, NOW)).not.toEqual([]);
    expect(validateCardDraft({ ...noSigma, targetValue: floor + 1 }, NOW)).toEqual([]);
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

  it('총량 상한: 자산군을 나눠도 합쳐서 센다', () => {
    // 무표기는 자산군당 5장이지만 셋에 나누면 15장이 열린다 — 총량으로 묶는다
    expect(MAX_ACTIVE_CARDS_TOTAL.BRONZE).toBe(8);
    expect(() =>
      preparePublish(validCard, { ...validCond, activeCardCountTotal: 8 }, 70_000, NOW),
    ).toThrow(/전체 동시 활성 카드/);
    expect(
      preparePublish(validCard, { ...validCond, activeCardCountTotal: 7 }, 70_000, NOW).feeRateBp,
    ).toBe(2000);
  });

  it('한 자산군만 다루면 총량 상한에 걸리지 않는다 — 자산군별 상한이 먼저 잡는다', () => {
    // 자산군별 5장이 총량 8장보다 작으므로, 한 곳만 쓰는 사람은 총량을 볼 일이 없다
    for (const tier of Object.keys(MAX_ACTIVE_CARDS) as (keyof typeof MAX_ACTIVE_CARDS)[]) {
      expect(MAX_ACTIVE_CARDS[tier]).toBeLessThan(MAX_ACTIVE_CARDS_TOTAL[tier]);
    }
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

  // **리서처를 막는 규칙이 아니라 지키는 규칙이다.** 신규는 100% 성과 연동이라
  // 첫 카드를 365일로 걸면 1년 동안 정산도 실적도 0인 채로 버텨야 한다 —
  // 콜드스타트 이탈이 나는 자리가 정확히 여기다
  it('판정을 한 번도 못 받은 사람은 아주 긴 카드를 걸 수 없다', () => {
    // 시한 300일 — 신규가 이걸 걸면 1년 가까이 정산도 실적도 0이다
    const veryLong = { ...validCard, deadline: new Date('2027-05-08T00:00:00Z'), targetValue: 20 };
    expect(() =>
      preparePublish(veryLong, { ...validCond, judgedCardCount: 0 }, 70_000, NOW),
    ).toThrow(new RegExp(`시한 ${NEW_RESEARCHER_MAX_HORIZON_DAYS}일 초과`));

    // 한 번 판정을 받으면 바로 열린다 (JUDGED_BEFORE_LONG_CARDS = 1)
    expect(
      preparePublish(veryLong, { ...validCond, judgedCardCount: 1 }, 70_000, NOW).feeRateBp,
    ).toBe(2000);
  });

  // **문턱을 LONG_HORIZON_DAYS(90)와 따로 두는 이유가 이것이다.** 90일 카드는 한 시즌
  // 안에 판정이 나 등급 평가도 받는다 — 막을 이유가 없다. 문제는 365일짜리다
  it('한 시즌 안에 끝나는 카드는 신규도 그대로 낼 수 있다', () => {
    // validCard는 시한 92일 — 장기 카드이긴 하지만 두 시즌 안이다
    expect(
      preparePublish(validCard, { ...validCond, judgedCardCount: 0 }, 70_000, NOW).feeRateBp,
    ).toBe(2000);
  });

  // **등급이 아니라 판정 이력으로 가른다** — 무표기에는 "아직 아무것도 안 한 사람"과
  // "판정은 여럿 받았지만 점수가 모자란 사람"이 섞여 있다. 뒤쪽의 기간 선택을 뺏으면 안 된다
  it('무표기여도 판정 이력이 있으면 아주 긴 카드가 열린다', () => {
    const veryLong = { ...validCard, deadline: new Date('2027-05-08T00:00:00Z'), targetValue: 20 };
    expect(
      preparePublish(veryLong, { ...validCond, tier: 'BRONZE', judgedCardCount: 3 }, 70_000, NOW)
        .feeRateBp,
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

  // **문턱 자체를 못 박는다** (2026-08-16). 이 값이 7이던 동안 **아무 시험도 그 자리를
  // 잡고 있지 않았다** — 7 → 14로 바꿔도 1,020건이 전부 통과했다. 근거가 기록되지
  // 않은 숫자였던 것과 시험이 없던 것은 같은 구멍의 두 얼굴이다.
  it(`주식 카드는 시한 ${EQUITY_SHORT_HORIZON_DAYS}일을 경계로 취급이 갈린다`, () => {
    const monPreOpen = new Date('2026-07-12T22:00:00Z'); // KST 월 07:00
    const at = (days: number) =>
      planBaseMode('KR_EQUITY', new Date(monPreOpen.getTime() + days * 86_400_000), monPreOpen)
        .baseMode;
    // 문턱 미만 → 컷오프 규칙 (개장 전이므로 직전 거래일 종가)
    expect(at(EQUITY_SHORT_HORIZON_DAYS - 1)).toBe('PREV_CLOSE_AT_PUBLISH');
    // 문턱 이상 → 일반 카드 (게시 순간 가격)
    expect(at(EQUITY_SHORT_HORIZON_DAYS)).toBe('FIXED_AT_PUBLISH');
    // 코인은 문턱과 무관하게 늘 게시 시점 확정
    expect(planBaseMode('CRYPTO', new Date(monPreOpen.getTime() + 86_400_000), monPreOpen).baseMode).toBe(
      'FIXED_AT_PUBLISH',
    );
  });

  // **개장 전 카드도 기준가를 게시 시점에 확정한다** (2026-08-16).
  // 직전 거래일 종가는 어제 마감 +5분에 이미 확정된 값이고, KIS는 개장 전에도 그대로
  // 준다(실측: KST 02:52에 직전 거래일 종가 수신). 미루던 이유는 금융위 D+1 지연이었고
  // 2026-08-10 KIS 전환으로 사라졌는데 방식만 남아 있었다
  it('KR 단기 카드: 평일 개장 전 게시 → 직전 거래일 종가를 게시 시점에 확정', () => {
    // KST 2026-07-13(월) 07:00 — 동시호가(08:30) 전
    const monPreOpen = new Date('2026-07-12T22:00:00Z');
    const card: CardDraft = { ...validCard, deadline: new Date('2026-07-13T06:30:00Z') }; // 당일 15:30 KST
    const snap = preparePublish(card, validCond, 70_000, monPreOpen);
    expect(snap.baseMode).toBe('PREV_CLOSE_AT_PUBLISH');
    expect(snap.basePrice).toBe(70_000);
  });

  // 기준가를 알게 된 대가로 **검증이 따라온다** — 미룰 때는 이것들을 못 했다
  it('개장 전 카드도 방향 정합성·크기 하한 검증을 받는다', () => {
    const monPreOpen = new Date('2026-07-12T22:00:00Z');
    const card: CardDraft = {
      ...validCard,
      targetType: 'TARGET_PRICE',
      targetValue: 60_000, // 상승 예측인데 기준가(70,000) 아래
      deadline: new Date('2026-07-13T06:30:00Z'),
    };
    expect(() => preparePublish(card, validCond, 70_000, monPreOpen)).toThrow(/목표가/);
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

  // 소급 확정은 이제 **장중·장후·주말 게시 단기 카드(DAY_CLOSE_AT_JUDGMENT)에만** 남는다.
  // 그쪽은 기준가가 "게시 이후 첫 종가"라 게시 시점에 존재하지 않는 값이고, 그래서
  // 목표가의 방향 정합성·크기 하한을 검증할 대상이 없다 (개장 전 카드와 갈리는 지점)
  it('기준가 소급 확정 단기 카드는 수익률형만 허용 (목표가형 거부)', () => {
    const monOpen = new Date('2026-07-13T00:00:00Z'); // KST 월 09:00 — 장중
    const card: CardDraft = {
      ...validCard,
      targetType: 'TARGET_PRICE',
      targetValue: 80_000,
      deadline: new Date('2026-07-15T06:30:00Z'), // +2일
    };
    expect(() => preparePublish(card, validCond, null, monOpen)).toThrow(/수익률형/);
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
