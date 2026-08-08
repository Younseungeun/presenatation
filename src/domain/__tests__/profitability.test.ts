import { describe, expect, it } from 'vitest';
import {
  cardProfitabilityLevel,
  PROFITABILITY_LABEL,
  profitabilityLevel,
  profitabilityText,
} from '../profitability';

describe('profitabilityLevel — 예측 크기 → 5구간 (경계 1.5/2/3/5 ×F)', () => {
  it('주식(F=5%): 5→LV1, 7.5→LV2, 10→LV3, 15→LV4, 25→LV5', () => {
    expect(profitabilityLevel('KR_EQUITY', 5)).toBe(1);
    expect(profitabilityLevel('KR_EQUITY', 7.4)).toBe(1);
    expect(profitabilityLevel('KR_EQUITY', 7.5)).toBe(2);
    expect(profitabilityLevel('KR_EQUITY', 10)).toBe(3);
    expect(profitabilityLevel('KR_EQUITY', 15)).toBe(4);
    expect(profitabilityLevel('KR_EQUITY', 25)).toBe(5);
    expect(profitabilityLevel('KR_EQUITY', 80)).toBe(5); // 개방형 상단
  });

  it('코인(F=10%): 같은 배수면 같은 레벨 — 주식 10%와 코인 20%는 둘 다 LV3', () => {
    expect(profitabilityLevel('CRYPTO', 10)).toBe(1);
    expect(profitabilityLevel('CRYPTO', 20)).toBe(3);
    expect(profitabilityLevel('CRYPTO', 20)).toBe(profitabilityLevel('KR_EQUITY', 10));
    expect(profitabilityLevel('CRYPTO', 50)).toBe(5);
  });

  it('미국주식은 국내주식과 같은 하한(5%)을 쓴다', () => {
    expect(profitabilityLevel('US_EQUITY', 12)).toBe(profitabilityLevel('KR_EQUITY', 12));
  });
});

describe('cardProfitabilityLevel — 카드에서 산출', () => {
  it('수익률형은 targetValue 그대로', () => {
    expect(
      cardProfitabilityLevel({
        assetClass: 'CRYPTO',
        targetType: 'RETURN_PCT',
        targetValue: 30,
        basePrice: null,
      }),
    ).toBe(4);
  });

  it('목표가형은 기준가 대비 %로 환산 (기준가 100 → 목표가 110 = 10% → 주식 LV3)', () => {
    expect(
      cardProfitabilityLevel({
        assetClass: 'KR_EQUITY',
        targetType: 'TARGET_PRICE',
        targetValue: 110,
        basePrice: 100,
      }),
    ).toBe(3);
  });

  it('목표가형인데 기준가가 아직 없으면 null (게시 전 상태)', () => {
    expect(
      cardProfitabilityLevel({
        assetClass: 'KR_EQUITY',
        targetType: 'TARGET_PRICE',
        targetValue: 110,
        basePrice: null,
      }),
    ).toBeNull();
  });
});

describe('라벨', () => {
  it('5구간 전부 라벨이 있고, null은 —', () => {
    for (const lv of [1, 2, 3, 4, 5] as const) {
      expect(PROFITABILITY_LABEL[lv].length).toBeGreaterThan(0);
      expect(profitabilityText(lv)).toBe(PROFITABILITY_LABEL[lv]);
    }
    expect(profitabilityText(null)).toBe('—');
  });
});
