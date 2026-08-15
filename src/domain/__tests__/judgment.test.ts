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

// **얼마나 갔었는지를 재되, 판정에는 한 톨도 쓰지 않는다** (2026-08-15).
//
// 외부 검토가 짚은 리서처 이탈 시나리오: "+9.8%로 끝났는데 사기꾼 취급을 받는다".
// 처분(환불·점수·적중률)은 하나도 바꾸지 않는다 — 근접을 봐주면 "목표의 몇 %까지는
// 맞은 셈"이라는 새 경계가 생기고, 경계가 생기면 그 경계를 노리는 신고가 생긴다.
// 바뀌는 것은 **같은 처분을 설명하는 방식**뿐이라, 이 값은 알림에만 실린다.
describe('peakProgress — 실패한 카드가 목표에 얼마나 가까웠나', () => {
  const upCard: PredictionInput = {
    direction: 'UP',
    targetType: 'TARGET_PRICE',
    targetValue: 120000,
    basePrice: 100000,
  };

  it('기준가 0 · 목표가 1의 눈금 — 구매자 상황 막대와 같은 자다', () => {
    const r = judge(upCard, traded({ maxCloseSincePublish: 118000, priceAtDeadline: 105000 }));
    expect(r.outcome).toBe('MISS');
    expect(r.peakProgress).toBeCloseTo(0.9, 10); // 18,000 / 20,000
  });

  it('하락 카드도 부호 분기 없이 맞는다 — 분모가 함께 뒤집힌다', () => {
    const downCard: PredictionInput = { ...upCard, direction: 'DOWN', targetValue: 80000 };
    const r = judge(downCard, traded({ minCloseSincePublish: 82000, priceAtDeadline: 95000 }));
    expect(r.outcome).toBe('MISS');
    expect(r.peakProgress).toBeCloseTo(0.9, 10); // −18,000 / −20,000
  });

  it('역방향으로 갔으면 음수 — 0으로 눌러 "조금은 갔다"로 보이게 하지 않는다', () => {
    const r = judge(upCard, traded({ maxCloseSincePublish: 96000, priceAtDeadline: 94000 }));
    expect(r.peakProgress).toBeCloseTo(-0.2, 10);
  });

  it('적중에는 실리지 않는다 — 도달한 카드에 "얼마나 갔나"는 뜻이 없다', () => {
    expect(judge(upCard, traded({ maxCloseSincePublish: 121000 })).peakProgress).toBeUndefined();
  });

  it('판정 결과 자체는 달라지지 않는다 — 0.99여도 MISS다', () => {
    const r = judge(upCard, traded({ maxCloseSincePublish: 119800, priceAtDeadline: 119800 }));
    expect(r.outcome).toBe('MISS');
    expect(r.settledPrice).toBe(119800); // 실패는 여전히 시한 종가로 잰다
    expect(r.peakProgress).toBeCloseTo(0.99, 10);
  });
});
