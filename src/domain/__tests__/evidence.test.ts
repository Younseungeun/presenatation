import { describe, expect, it } from 'vitest';
import { clusterEvidence, CORRELATION_CORRECTION, type EvidenceCard } from '../evidence';

// 규율 증거의 상관 보정 — 동시에 열려 있던 상관 카드를 독립 시행으로 세면
// Ville 부등식의 전제가 깨진다 (evidence.ts 주석).

const DAY = 86_400_000;
function card(over: Partial<EvidenceCard> = {}): EvidenceCard {
  return {
    assetClass: 'KR_EQUITY',
    direction: 'UP',
    openedAt: 0,
    closedAt: 10 * DAY,
    info: -1,
    ...over,
  };
}

describe('clusterEvidence — 무엇을 한 묶음으로 보나', () => {
  it('겹치지 않는 카드는 각각 센다 — 앞 카드의 결과를 알고 낸 신고다', () => {
    const e = clusterEvidence([
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 11 * DAY, closedAt: 20 * DAY, info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-2, 10);
  });

  it('겹치는 같은 자산군·방향 카드는 평균 한 항으로 줄인다', () => {
    const e = clusterEvidence([
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 1 * DAY, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 2 * DAY, closedAt: 10 * DAY, info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-1, 10);
  });

  it('방향이 다르면 묶지 않는다 — 상관된 종목에 반대 방향이면 음의 상관이라 안전하다', () => {
    const e = clusterEvidence([
      card({ direction: 'UP', info: -1 }),
      card({ direction: 'DOWN', info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-2, 10);
  });

  it('자산군이 다르면 묶지 않고, 집계도 자산군별로 갈린다', () => {
    const e = clusterEvidence([
      card({ assetClass: 'KR_EQUITY', info: -1 }),
      card({ assetClass: 'CRYPTO', info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-1, 10);
    expect(e.CRYPTO).toBeCloseTo(-1, 10);
  });

  it('묶음은 연쇄로 이어진다 — A와 B가 겹치고 B와 C가 겹치면 셋이 한 묶음', () => {
    const e = clusterEvidence([
      card({ openedAt: 0, closedAt: 10 * DAY, info: -3 }),
      card({ openedAt: 9 * DAY, closedAt: 20 * DAY, info: -3 }),
      card({ openedAt: 19 * DAY, closedAt: 30 * DAY, info: -3 }),
    ]);
    // 첫 카드가 닫히기 전에 둘째가 열렸고, 둘째가 닫히기 전에 셋째가 열렸다
    expect(e.KR_EQUITY).toBeCloseTo(-3, 10);
  });

  it('입력 순서가 결과를 바꾸지 않는다 — 게시 시각으로 정렬해 훑는다', () => {
    const cards = [
      card({ openedAt: 5 * DAY, closedAt: 15 * DAY, info: -2 }),
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 30 * DAY, closedAt: 40 * DAY, info: -4 }),
    ];
    const a = clusterEvidence(cards).KR_EQUITY;
    const b = clusterEvidence([...cards].reverse()).KR_EQUITY;
    expect(a).toBeCloseTo(b, 10);
    expect(a).toBeCloseTo(-1.5 - 4, 10);
  });
});

describe('보정은 안전한 방향으로만 틀린다', () => {
  it('|증거|를 늘리지 않는다 — 보정이 처분을 만들어내면 안 된다', () => {
    const cards = [
      card({ openedAt: 0, closedAt: 10 * DAY, info: -5 }),
      card({ openedAt: 1 * DAY, closedAt: 10 * DAY, info: -0.1 }),
    ];
    const corrected = clusterEvidence(cards).KR_EQUITY;
    const raw = clusterEvidence(cards, 'NONE').KR_EQUITY;
    expect(corrected).toBeGreaterThan(raw); // 덜 음수 = 덜 처분
    expect(Math.abs(corrected)).toBeLessThan(Math.abs(raw));
  });

  it('양수 증거도 같은 규칙으로 줄인다 — 한쪽만 깎으면 그 자체가 편향이다', () => {
    const cards = [
      card({ openedAt: 0, closedAt: 10 * DAY, info: 2 }),
      card({ openedAt: 1 * DAY, closedAt: 10 * DAY, info: 2 }),
    ];
    expect(clusterEvidence(cards).KR_EQUITY).toBeCloseTo(2, 10);
  });

  it('묶음 기준에 결과(info)가 들어가지 않는다 — 결과를 보고 묶으면 새 악용 경로다', () => {
    // 같은 시각 구조인데 info만 다른 두 입력이 같은 묶음 모양을 낸다
    const shape = (i1: number, i2: number) =>
      clusterEvidence([
        card({ openedAt: 0, closedAt: 10 * DAY, info: i1 }),
        card({ openedAt: 1 * DAY, closedAt: 10 * DAY, info: i2 }),
      ]).KR_EQUITY;
    expect(shape(-4, -2)).toBeCloseTo(-3, 10); // 평균
    expect(shape(-2, -4)).toBeCloseTo(-3, 10); // 순서를 바꿔도 같은 평균
  });
});

describe('보정 방식', () => {
  it('도메인은 평균(MEAN)을 쓴다', () => {
    expect(CORRELATION_CORRECTION).toBe('MEAN');
  });

  it('NONE은 단순 합 — 보정 전후를 비교하는 시뮬용 경로다', () => {
    const cards = [card({ info: -1 }), card({ openedAt: DAY, info: -1 })];
    expect(clusterEvidence(cards, 'NONE').KR_EQUITY).toBeCloseTo(-2, 10);
  });

  it('FIRST는 먼저 게시된 한 장만 센다', () => {
    const cards = [
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: DAY, closedAt: 10 * DAY, info: -9 }),
    ];
    expect(clusterEvidence(cards, 'FIRST').KR_EQUITY).toBeCloseTo(-1, 10);
  });

  it('카드가 없으면 모든 자산군이 0', () => {
    const e = clusterEvidence([]);
    expect(e.KR_EQUITY).toBe(0);
    expect(e.US_EQUITY).toBe(0);
    expect(e.CRYPTO).toBe(0);
  });
});
