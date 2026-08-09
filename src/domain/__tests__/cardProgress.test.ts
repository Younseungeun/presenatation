import { describe, expect, it } from 'vitest';
import { computeCardProgress, fillPercent } from '../cardProgress';

// 진행 계산 — 화면이 "잘 되고 있나"에 답하는 근거다.
// 방향 분기를 두지 않는 것이 설계의 핵심이라, 상승·하락이 같은 식으로 맞는지 못 박는다.

const base = {
  publishedAt: new Date('2026-08-01T00:00:00Z'),
  deadline: new Date('2026-08-11T00:00:00Z'), // 10일짜리
  now: new Date('2026-08-07T00:00:00Z'), // 6일 경과 = 60%
};

describe('시간 진행', () => {
  it('게시 → 시한 사이 위치를 0~1로', () => {
    const p = computeCardProgress({
      ...base,
      basePrice: null,
      currentPrice: null,
      targetPrice: null,
      direction: 'UP',
    });
    expect(p.timeRatio).toBeCloseTo(0.6, 6);
  });

  it('시한을 넘기면 1에서 멈추고 판정 대기로 표시한다', () => {
    const p = computeCardProgress({
      ...base,
      now: new Date('2026-08-20T00:00:00Z'),
      basePrice: null,
      currentPrice: null,
      targetPrice: null,
      direction: 'UP',
    });
    expect(p.timeRatio).toBe(1);
    expect(p.awaitingJudgment).toBe(true);
  });

  it('게시일을 몰라도 시간축이 사라지지 않는다 (30일 가정)', () => {
    const p = computeCardProgress({
      ...base,
      publishedAt: null,
      basePrice: null,
      currentPrice: null,
      targetPrice: null,
      direction: 'UP',
    });
    expect(p.timeRatio).toBeGreaterThan(0);
    expect(p.timeRatio).toBeLessThan(1);
  });
});

describe('달성률 — 방향 분기 없이 부호가 맞아야 한다', () => {
  it('상승: 기준 100 → 목표 110, 현재 104면 40%', () => {
    const p = computeCardProgress({
      ...base,
      basePrice: 100,
      targetPrice: 110,
      currentPrice: 104,
      direction: 'UP',
    });
    expect(p.achievement).toBeCloseTo(0.4, 6);
    expect(p.currentReturnPct).toBeCloseTo(4, 6);
  });

  it('하락: 기준 100 → 목표 90, 현재 96이면 같은 40%', () => {
    const p = computeCardProgress({
      ...base,
      basePrice: 100,
      targetPrice: 90,
      currentPrice: 96,
      direction: 'DOWN',
    });
    expect(p.achievement).toBeCloseTo(0.4, 6);
    expect(p.currentReturnPct).toBeCloseTo(-4, 6);
  });

  it('역방향으로 가면 달성률이 음수 — 막대는 채우지 않는다', () => {
    const p = computeCardProgress({
      ...base,
      basePrice: 100,
      targetPrice: 110,
      currentPrice: 97,
      direction: 'UP',
    });
    expect(p.achievement).toBeLessThan(0);
    expect(fillPercent(p.achievement)).toBe(0);
  });

  it('목표를 넘어서도 막대는 100%에서 멈춘다 (도달은 별도 플래그)', () => {
    const p = computeCardProgress({
      ...base,
      basePrice: 100,
      targetPrice: 110,
      currentPrice: 130,
      direction: 'UP',
    });
    expect(p.achievement).toBeCloseTo(3, 6);
    expect(fillPercent(p.achievement)).toBe(100);
    expect(p.reachedTarget).toBe(true);
  });

  it('시세가 없으면 달성률은 null — 0%로 오해되면 안 된다', () => {
    const p = computeCardProgress({
      ...base,
      basePrice: 100,
      targetPrice: 110,
      currentPrice: null,
      direction: 'UP',
    });
    expect(p.achievement).toBeNull();
    expect(p.currentReturnPct).toBeNull();
  });

  it('기준가가 아직 없으면(소급 확정) 달성률도 없다', () => {
    const p = computeCardProgress({
      ...base,
      basePrice: null,
      targetPrice: 110,
      currentPrice: 104,
      direction: 'UP',
    });
    expect(p.achievement).toBeNull();
  });
});
