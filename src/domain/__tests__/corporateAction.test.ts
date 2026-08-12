import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_EPSILON,
  detectAdjustment,
  MAX_FACTOR,
  rebase,
} from '../corporateAction';

// 앵커 방식 — "같은 거래일의 종가가 달라졌다"만으로 권리 사건을 잡는다.
// 가격이 오르내린 것과 무관해야 하고, 임계값 없이 정확한 배수가 나와야 한다.

describe('detectAdjustment — 변할 리 없는 값이 변했는가', () => {
  it('사건이 없으면 null — 같은 날 종가는 그대로다', () => {
    expect(detectAdjustment(71_300, 71_300)).toBeNull();
  });

  it('반올림 수준의 차이는 사건이 아니다', () => {
    expect(detectAdjustment(71_300, 71_300 * (1 + ADJUSTMENT_EPSILON / 2))).toBeNull();
  });

  it('2:1 분할 → 배수 0.5가 정확히 나온다 (임계값 튜닝 없이)', () => {
    const d = detectAdjustment(71_300, 35_650)!;
    expect(d.factor).toBeCloseTo(0.5, 10);
    expect(d.applicable).toBe(true);
  });

  it('무상증자 5% 같은 작은 조정도 잡는다 — 비율 검출로는 잡음에 묻히던 크기', () => {
    const d = detectAdjustment(10_000, 10_000 / 1.05)!;
    expect(d.factor).toBeCloseTo(1 / 1.05, 10);
    expect(d.applicable).toBe(true);
  });

  it('액면병합(1/5)도 같은 규칙으로 잡힌다', () => {
    expect(detectAdjustment(1_000, 5_000)!.factor).toBeCloseTo(5, 10);
  });

  it('말이 안 되는 배수는 자동 적용하지 않는다 — 데이터 사고를 조용히 반영하지 않는다', () => {
    const d = detectAdjustment(1, 1_000_000)!;
    expect(d.factor).toBeGreaterThan(MAX_FACTOR);
    expect(d.applicable).toBe(false);
  });

  it('0·음수 종가는 판단하지 않는다', () => {
    expect(detectAdjustment(0, 100)).toBeNull();
    expect(detectAdjustment(100, 0)).toBeNull();
  });
});

describe('rebase — 새 눈금으로 옮기기', () => {
  it('목표가형은 기준가·목표가를 함께 옮긴다', () => {
    const r = rebase({ basePrice: 71_000, targetType: 'TARGET_PRICE', targetValue: 85_000 }, 0.5);
    expect(r.basePrice).toBeCloseTo(35_500, 10);
    expect(r.targetValue).toBeCloseTo(42_500, 10);
  });

  it('**수익률형의 목표는 건드리지 않는다** — 비율은 눈금이 바뀌어도 그대로 참이다', () => {
    const r = rebase({ basePrice: 71_000, targetType: 'RETURN_PCT', targetValue: 20 }, 0.5);
    expect(r.basePrice).toBeCloseTo(35_500, 10);
    expect(r.targetValue).toBe(20);
  });

  it('리베이스 후에도 목표까지의 거리(비율)가 보존된다 — 예측 난이도가 바뀌면 안 된다', () => {
    const before = { basePrice: 71_000, targetType: 'TARGET_PRICE' as const, targetValue: 85_200 };
    const after = rebase(before, 0.5);
    expect(after.targetValue / after.basePrice).toBeCloseTo(
      before.targetValue / before.basePrice,
      10,
    );
  });
});
