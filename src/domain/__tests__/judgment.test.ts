import { describe, expect, it } from 'vitest';
import { judge, type MarketSnapshot, type PredictionInput } from '../judgment';

const traded = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  status: 'TRADED',
  ...over,
});

describe('judge — TARGET_PRICE (목표가 도달)', () => {
  const upCard: PredictionInput = {
    direction: 'UP',
    targetType: 'TARGET_PRICE',
    targetValue: 120000,
    basePrice: 100000,
  };

  it('기간 중 고가가 목표가에 도달하면 HIT', () => {
    expect(judge(upCard, traded({ highSincePublish: 121000 }))).toMatchObject({ outcome: 'HIT' });
  });

  it('목표가 미도달이면 MISS', () => {
    expect(judge(upCard, traded({ highSincePublish: 115000 }))).toMatchObject({ outcome: 'MISS' });
  });

  it('하락 예측은 기간 중 저가 기준으로 판정', () => {
    const downCard: PredictionInput = { ...upCard, direction: 'DOWN', targetValue: 80000 };
    expect(judge(downCard, traded({ lowSincePublish: 79000 }))).toMatchObject({ outcome: 'HIT' });
    expect(judge(downCard, traded({ lowSincePublish: 85000 }))).toMatchObject({ outcome: 'MISS' });
  });

  it('필요 데이터가 없으면 UNDECIDABLE(AMBIGUOUS)', () => {
    expect(judge(upCard, traded())).toMatchObject({
      outcome: 'UNDECIDABLE',
      undecidableReason: 'AMBIGUOUS',
    });
  });
});

describe('judge — RETURN_PCT (기준가 대비 등락률)', () => {
  const card: PredictionInput = {
    direction: 'UP',
    targetType: 'RETURN_PCT',
    targetValue: 10, // +10% 이상 상승 예측
    basePrice: 100000,
  };

  it('시한 종가 수익률이 목표 이상이면 HIT', () => {
    expect(judge(card, traded({ priceAtDeadline: 110000 }))).toMatchObject({ outcome: 'HIT' });
  });

  it('목표 미만이면 MISS', () => {
    expect(judge(card, traded({ priceAtDeadline: 109999 }))).toMatchObject({ outcome: 'MISS' });
  });

  it('하락 예측: -10% 이상 하락해야 HIT', () => {
    const down: PredictionInput = { ...card, direction: 'DOWN' };
    expect(judge(down, traded({ priceAtDeadline: 90000 }))).toMatchObject({ outcome: 'HIT' });
    expect(judge(down, traded({ priceAtDeadline: 95000 }))).toMatchObject({ outcome: 'MISS' });
  });
});

describe('judge — 판정 불가 케이스', () => {
  const card: PredictionInput = {
    direction: 'UP',
    targetType: 'RETURN_PCT',
    targetValue: 10,
    basePrice: 100000,
  };

  it('거래정지 → UNDECIDABLE(TRADING_HALT)', () => {
    expect(judge(card, { status: 'TRADING_HALT' })).toMatchObject({
      outcome: 'UNDECIDABLE',
      undecidableReason: 'TRADING_HALT',
    });
  });

  it('상장폐지 → UNDECIDABLE(DELISTED)', () => {
    expect(judge(card, { status: 'DELISTED' })).toMatchObject({
      outcome: 'UNDECIDABLE',
      undecidableReason: 'DELISTED',
    });
  });

  it('철회된 카드 → UNDECIDABLE(WITHDRAWN), 시장 상태와 무관', () => {
    expect(judge({ ...card, withdrawn: true }, traded({ priceAtDeadline: 120000 }))).toMatchObject({
      outcome: 'UNDECIDABLE',
      undecidableReason: 'WITHDRAWN',
    });
  });
});
