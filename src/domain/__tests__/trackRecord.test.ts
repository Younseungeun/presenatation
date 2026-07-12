import { describe, expect, it } from 'vitest';
import { computeTrackRecord, type JudgedPrediction } from '../trackRecord';

const NOW = new Date('2026-07-12T00:00:00Z');

function pred(over: Partial<JudgedPrediction>): JudgedPrediction {
  return {
    outcome: 'HIT',
    direction: 'UP',
    basePrice: 100,
    settledPrice: 110,
    judgedAt: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

describe('computeTrackRecord', () => {
  it('표본 0건이면 지표 null + 검증 중 배지', () => {
    const r = computeTrackRecord([], NOW);
    expect(r.sampleSize).toBe(0);
    expect(r.hitRate).toBeNull();
    expect(r.verifying).toBe(true);
  });

  it('판정 불가 건은 표본에서 제외', () => {
    const r = computeTrackRecord([pred({}), pred({ outcome: 'UNDECIDABLE' })], NOW);
    expect(r.sampleSize).toBe(1);
  });

  it('최소 표본(10건) 미만은 검증 중, 이상은 검증 완료', () => {
    const nine = Array.from({ length: 9 }, () => pred({}));
    expect(computeTrackRecord(nine, NOW).verifying).toBe(true);
    const ten = Array.from({ length: 10 }, () => pred({}));
    expect(computeTrackRecord(ten, NOW).verifying).toBe(false);
  });

  it('적중률과 최근 12개월 적중률을 분리 계산', () => {
    const r = computeTrackRecord(
      [
        pred({ outcome: 'HIT', judgedAt: new Date('2024-01-01') }), // 12개월 밖
        pred({ outcome: 'MISS', judgedAt: new Date('2026-06-01') }),
        pred({ outcome: 'HIT', judgedAt: new Date('2026-06-02') }),
      ],
      NOW,
    );
    expect(r.hitRate).toBeCloseTo(2 / 3);
    expect(r.recentHitRate).toBeCloseTo(1 / 2);
  });

  it('가상 포트폴리오 수익률: 하락 예측 적중은 양수 수익으로 계산', () => {
    const r = computeTrackRecord(
      [
        pred({ direction: 'UP', basePrice: 100, settledPrice: 110 }), // +10%
        pred({ direction: 'DOWN', basePrice: 100, settledPrice: 90, outcome: 'HIT' }), // +10%
      ],
      NOW,
    );
    expect(r.hypotheticalReturnPct).toBeCloseTo(10);
  });
});
