import { describe, expect, it } from 'vitest';
import {
  disciplineFor,
  lossAmplifier,
  winAmplifier,
} from '../scoring';
import { preparePublish, type CardDraft, type PublishConditions } from '../publishReport';

const NOW = new Date('2026-07-12T00:00:00Z');

const card: CardDraft = {
  assetClass: 'KR_EQUITY',
  ticker: '005930',
  assetName: '삼성전자',
  direction: 'UP',
  targetType: 'RETURN_PCT',
  targetValue: 10,
  deadline: new Date('2026-10-12T00:00:00Z'),
  confidence: 1,
  selfStability: 5,
  selfProfitability: 5,
};

const cond: PublishConditions = {
  priceKrw: 20_000,
  prepaymentRatio: 0,
  tier: 'BRONZE',
  promoActive: false,
};

describe('disciplineFor — 마이너스 점수 규율 래더', () => {
  it('0점 이상·얕은 마이너스는 제약 없음', () => {
    expect(disciplineFor(0)).toEqual({ minConfidence: 1, publishSuspended: false });
    expect(disciplineFor(-999)).toEqual({ minConfidence: 1, publishSuspended: false });
  });

  it('마이너스가 깊어질수록 최소 신뢰도 상승', () => {
    expect(disciplineFor(-1_000).minConfidence).toBe(3);
    expect(disciplineFor(-3_000).minConfidence).toBe(5);
    expect(disciplineFor(-6_000).minConfidence).toBe(7);
  });

  it('-10,000 이하는 신규 게시 정지', () => {
    expect(disciplineFor(-10_000).publishSuspended).toBe(true);
  });

  it('점수가 회복되면 자동 완화 (현재 점수의 함수)', () => {
    expect(disciplineFor(-2_999).minConfidence).toBe(3);
    expect(disciplineFor(-500).minConfidence).toBe(1);
  });
});

describe('규율의 경제적 효과 — 저품질 대량 게시 차단', () => {
  it('승률 55% 스패머: 신뢰도 1에서는 기대 점수 +, 강제 신뢰도 3에서는 −', () => {
    const p = 0.55;
    const evAt = (c: number) => p * winAmplifier(c) - (1 - p) * lossAmplifier(c);
    expect(evAt(1)).toBeGreaterThan(0); // 규율 전: 은신처 존재
    expect(evAt(3)).toBeLessThan(0); // 규율 후: 시행할수록 손해
  });

  it('실력자(승률 85%)는 강제 신뢰도 5에서도 기대 점수 + (하한의 선별성)', () => {
    const p = 0.85;
    const evAt = (c: number) => p * winAmplifier(c) - (1 - p) * lossAmplifier(c);
    expect(evAt(5)).toBeGreaterThan(0);
  });
});

describe('preparePublish 규율 연동', () => {
  it('점수 -1,000 이하: 신뢰도 1 카드 게시 거부, 신뢰도 3이면 허용', () => {
    expect(() =>
      preparePublish(card, { ...cond, assetClassScore: -1_500 }, 70_000, NOW),
    ).toThrow(/신뢰도 3 이상/);
    expect(
      preparePublish(
        { ...card, confidence: 3 },
        { ...cond, assetClassScore: -1_500 },
        70_000,
        NOW,
      ).feeRateBp,
    ).toBe(2000);
  });

  it('점수 -10,000 이하: 신뢰도와 무관하게 게시 정지', () => {
    expect(() =>
      preparePublish(
        { ...card, confidence: 10 },
        { ...cond, assetClassScore: -12_000 },
        70_000,
        NOW,
      ),
    ).toThrow(/게시가 정지/);
  });

  it('점수 미제공(집계 배치 전)이면 규율 미발동', () => {
    expect(preparePublish(card, cond, 70_000, NOW).feeRateBp).toBe(2000);
  });
});
