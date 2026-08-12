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
    expect(judge(upCard, traded({ maxCloseSincePublish: 121000 }))).toMatchObject({ outcome: 'HIT' });
  });

  it('목표가 미도달이면 MISS', () => {
    expect(
      judge(upCard, traded({ maxCloseSincePublish: 115000, priceAtDeadline: 112000 })),
    ).toMatchObject({ outcome: 'MISS' });
  });

  it('하락 예측은 기간 중 저가 기준으로 판정', () => {
    const downCard: PredictionInput = { ...upCard, direction: 'DOWN', targetValue: 80000 };
    expect(judge(downCard, traded({ minCloseSincePublish: 79000 }))).toMatchObject({ outcome: 'HIT' });
    expect(
      judge(downCard, traded({ minCloseSincePublish: 85000, priceAtDeadline: 88000 })),
    ).toMatchObject({ outcome: 'MISS' });
  });

  it('필요 데이터가 없으면 UNDECIDABLE(AMBIGUOUS)', () => {
    expect(judge(upCard, traded())).toMatchObject({
      outcome: 'UNDECIDABLE',
      undecidableReason: 'AMBIGUOUS',
    });
  });
});

describe('judge — 수익률형도 같은 규칙 (목표가로 환산해 터치 판정)', () => {
  // **입력 형식은 판정을 바꾸지 않는다.** 기준가 100,000에서 "+10%"와 "110,000원"은
  // 같은 주장이고, 둘 다 "기한 안에 110,000에 닿았는가"로 판정된다.
  const card: PredictionInput = {
    direction: 'UP',
    targetType: 'RETURN_PCT',
    targetValue: 10,
    basePrice: 100000,
  };

  it('기간 중 고가가 환산 목표가에 닿으면 HIT — 시한 종가가 아래로 돌아와도', () => {
    expect(
      judge(card, traded({ maxCloseSincePublish: 111000, minCloseSincePublish: 99000, priceAtDeadline: 95000 })),
    ).toMatchObject({ outcome: 'HIT' });
  });

  it('한 번도 못 닿았으면 MISS — 시한 종가가 목표 위여도 그럴 수는 없다(고가 ≥ 종가)', () => {
    expect(
      judge(card, traded({ maxCloseSincePublish: 109999, minCloseSincePublish: 90000, priceAtDeadline: 109999 })),
    ).toMatchObject({ outcome: 'MISS' });
  });

  it('하락 예측은 저가 기준으로 같은 규칙', () => {
    const down: PredictionInput = { ...card, direction: 'DOWN' };
    expect(judge(down, traded({ minCloseSincePublish: 89000, maxCloseSincePublish: 101000 }))).toMatchObject({
      outcome: 'HIT',
    });
    expect(
      judge(down, traded({ minCloseSincePublish: 91000, maxCloseSincePublish: 101000, priceAtDeadline: 99000 })),
    ).toMatchObject({ outcome: 'MISS' });
  });

  it('기준가가 없으면 환산이 불가능해 판정하지 않는다', () => {
    expect(judge({ ...card, basePrice: 0 }, traded({ maxCloseSincePublish: 200000 }))).toMatchObject({
      outcome: 'UNDECIDABLE',
      undecidableReason: 'AMBIGUOUS',
    });
  });
});

describe('judge — 판정가는 초과분을 넣지 않는다', () => {
  const card: PredictionInput = {
    direction: 'UP',
    targetType: 'TARGET_PRICE',
    targetValue: 120000,
    basePrice: 100000,
  };

  it('적중이면 판정가 = 목표가 (얼마나 더 갔든)', () => {
    expect(judge(card, traded({ maxCloseSincePublish: 121000 })).settledPrice).toBe(120000);
    expect(judge(card, traded({ maxCloseSincePublish: 200000 })).settledPrice).toBe(120000);
  });

  it('그래서 도달 시점에 판정하든 시한까지 기다리든 결과가 같다', () => {
    const 도달직후 = judge(card, traded({ maxCloseSincePublish: 120500 }));
    const 시한까지 = judge(card, traded({ maxCloseSincePublish: 180000 }));
    expect(도달직후).toEqual(시한까지);
  });

  it('실패면 판정가 = **시한 종가**', () => {
    expect(
      judge(card, traded({ maxCloseSincePublish: 118000, priceAtDeadline: 104000 })).settledPrice,
    ).toBe(104000);
  });

  it('스쳐 간 고점으로 실패를 후하게 봐주지 않는다', () => {
    // +20% 예측, 잠깐 +18%를 찍었다가 −10%로 끝난 카드.
    // 극값(118,000)으로 재면 "거의 맞혔다"가 되지만, 실제 결과는 −10%다
    const r = judge(card, traded({ maxCloseSincePublish: 118000, priceAtDeadline: 90000 }));
    expect(r.outcome).toBe('MISS');
    expect(r.settledPrice).toBe(90000);
  });

  it('실패인데 시한 종가가 없으면 판정하지 않는다', () => {
    expect(judge(card, traded({ maxCloseSincePublish: 118000 }))).toMatchObject({
      outcome: 'UNDECIDABLE',
      undecidableReason: 'AMBIGUOUS',
    });
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
