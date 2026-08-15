import { describe, expect, it } from 'vitest';
import { computeTrackRecord, hitRateLabel, type JudgedPrediction } from '../trackRecord';

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

// **돈이 걸린 예측만의 적중률** (2026-08-15).
//
// 외부 검토는 "무료 실적 카드는 틀려도 타격이 0이라 유료 카드와 같은 눈금에 두면
// 안 된다"고 했다. 지적은 맞지만 **범위가 틀렸다** — 그 성질은 무료 카드의 것이 아니라
// **안 팔린 카드**의 것이고, 그건 지금도 일어난다: 아무도 안 산 유료 카드는 틀려도
// 환불도 항의도 평판 손상도 하나도 없다. 가격표가 아니라 **구매 여부**로 갈라야 한다.
describe('팔린 카드와 안 팔린 카드를 가른다', () => {
  it('안 팔린 카드는 전체 표본에는 들어가고 "돈이 걸린" 표본에서는 빠진다', () => {
    const r = computeTrackRecord(
      [
        pred({ outcome: 'HIT', sold: true }),
        pred({ outcome: 'MISS', sold: true }),
        pred({ outcome: 'HIT', sold: false }),
        pred({ outcome: 'HIT', sold: false }),
      ],
      NOW,
    );
    // 예측으로서는 넷 다 진짜다 — 같은 규칙으로 판정됐고 점수에도 들어간다
    expect(r.sampleSize).toBe(4);
    expect(r.hitRate).toBe(0.75);
    // 그중 실제로 대가를 치른 것은 둘뿐이다
    expect(r.stakedSampleSize).toBe(2);
    expect(r.stakedHitRate).toBe(0.5);
  });

  it('판정 불가는 양쪽 표본에서 모두 빠진다', () => {
    const r = computeTrackRecord(
      [pred({ outcome: 'UNDECIDABLE', sold: true }), pred({ outcome: 'HIT', sold: true })],
      NOW,
    );
    expect(r.sampleSize).toBe(1);
    expect(r.stakedSampleSize).toBe(1);
  });

  it('sold를 안 준 옛 호출부는 **덜 세는 쪽**으로 떨어진다 (전부 걸린 것으로 잡지 않는다)', () => {
    const r = computeTrackRecord([pred({ outcome: 'HIT' }), pred({ outcome: 'HIT' })], NOW);
    expect(r.sampleSize).toBe(2);
    expect(r.stakedSampleSize).toBe(0);
    expect(r.stakedHitRate).toBeNull();
  });

  it('팔린 카드가 없으면 적중률 자리에 숫자를 지어내지 않는다', () => {
    const r = computeTrackRecord([pred({ outcome: 'HIT', sold: false })], NOW);
    expect(r.stakedHitRate).toBeNull();
    expect(hitRateLabel(r.stakedHitRate, r.stakedSampleSize, { none: '—' })).toBe('—');
  });
});
