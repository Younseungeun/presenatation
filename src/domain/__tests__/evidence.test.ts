import { describe, expect, it } from 'vitest';
import { aggregateEvidence, CORRELATION_CORRECTION, type EvidenceCard } from '../evidence';

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

describe('aggregateEvidence — 무엇을 얼마나 깎나', () => {
  it('겹치지 않는 카드는 각각 온전히 센다 — 앞 카드의 결과를 알고 낸 신고다', () => {
    const e = aggregateEvidence([
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 11 * DAY, closedAt: 20 * DAY, info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-2, 10);
  });

  it('완전히 겹친 n장은 정확히 평균 한 항이 된다 — 최악 가정 ρ=1의 설계효과', () => {
    const e = aggregateEvidence([
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-1, 10);
  });

  it('짧은 카드가 긴 카드 안에 통째로 들면 비율이 1이다 — 일생 전체가 겹쳤다', () => {
    // 짧은 쪽으로 나누지 않으면 이 카드가 덜 깎여 상관을 놓친다
    const e = aggregateEvidence([
      card({ openedAt: 0, closedAt: 100 * DAY, info: -1 }),
      card({ openedAt: 10 * DAY, closedAt: 20 * DAY, info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-1, 10);
  });

  it('절반만 겹치면 절반만 깎는다 — 스쳐 지나간 카드까지 묶지 않는다', () => {
    const e = aggregateEvidence([
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 5 * DAY, closedAt: 15 * DAY, info: -1 }),
    ]);
    // 겹침 5일 / 기간 10일 = 0.5 → 하중 1.5씩
    expect(e.KR_EQUITY).toBeCloseTo(-2 / 1.5, 10);
  });

  it('방향이 다르면 깎지 않는다 — 상관된 종목에 반대 방향이면 음의 상관이라 안전하다', () => {
    const e = aggregateEvidence([
      card({ direction: 'UP', info: -1 }),
      card({ direction: 'DOWN', info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-2, 10);
  });

  it('자산군이 다르면 깎지 않고, 집계도 자산군별로 갈린다', () => {
    const e = aggregateEvidence([
      card({ assetClass: 'KR_EQUITY', info: -1 }),
      card({ assetClass: 'CRYPTO', info: -1 }),
    ]);
    expect(e.KR_EQUITY).toBeCloseTo(-1, 10);
    expect(e.CRYPTO).toBeCloseTo(-1, 10);
  });

  it('연쇄가 없다 — A와 B가 겹치고 B와 C가 겹쳐도 A는 C 때문에 깎이지 않는다', () => {
    // 옛 묶음 방식의 결함: 셋을 한 묶음으로 만들어 −9를 −3으로 줄였다.
    // 그러면 꾸준히 게시하는 리서처의 시즌 전체가 묶음 하나가 되어
    // D가 카드 한 장의 정보량보다 아래로 못 내려가고 래더가 죽는다.
    const e = aggregateEvidence([
      card({ openedAt: 0, closedAt: 10 * DAY, info: -3 }),
      card({ openedAt: 9 * DAY, closedAt: 20 * DAY, info: -3 }),
      card({ openedAt: 19 * DAY, closedAt: 30 * DAY, info: -3 }),
    ]);
    // 이웃끼리 하루(≈10%)만 겹쳤으므로 −9에서 거의 깎이지 않는다
    expect(e.KR_EQUITY).toBeGreaterThan(-9);
    expect(e.KR_EQUITY).toBeLessThan(-7.9);
  });

  it('긴 카드 한 장이 이후 카드를 삼키지 못한다 — 자기 하중만 커진다', () => {
    // 시즌을 덮는 앵커 카드 + 겹치지 않는 짧은 카드 셋.
    // 짧은 카드끼리는 안 겹치므로 각자 하중 2(자기 + 앵커)로만 깎인다.
    const long = card({ openedAt: 0, closedAt: 90 * DAY, info: -1 });
    const shorts = [0, 30, 60].map((d) =>
      card({ openedAt: d * DAY, closedAt: (d + 10) * DAY, info: -1 }),
    );
    const e = aggregateEvidence([long, ...shorts]);
    // 앵커: 하중 1 + 10/10 × 3 = 4 → −0.25 · 짧은 카드: 하중 2씩 → −0.5 × 3
    expect(e.KR_EQUITY).toBeCloseTo(-0.25 - 1.5, 10);
  });

  it('입력 순서가 결과를 바꾸지 않는다 — 보정이 대칭이다', () => {
    const cards = [
      card({ openedAt: 5 * DAY, closedAt: 15 * DAY, info: -2 }),
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: 30 * DAY, closedAt: 40 * DAY, info: -4 }),
    ];
    const a = aggregateEvidence(cards).KR_EQUITY;
    const b = aggregateEvidence([...cards].reverse()).KR_EQUITY;
    expect(a).toBeCloseTo(b, 10);
    expect(a).toBeCloseTo(-1 / 1.5 - 2 / 1.5 - 4, 10);
  });
});

describe('보정은 안전한 방향으로만 틀린다', () => {
  it('|증거|를 늘리지 않는다 — 보정이 처분을 만들어내면 안 된다', () => {
    const cards = [
      card({ openedAt: 0, closedAt: 10 * DAY, info: -5 }),
      card({ openedAt: 1 * DAY, closedAt: 10 * DAY, info: -0.1 }),
    ];
    const corrected = aggregateEvidence(cards).KR_EQUITY;
    const raw = aggregateEvidence(cards, 'NONE').KR_EQUITY;
    expect(corrected).toBeGreaterThan(raw); // 덜 음수 = 덜 처분
    expect(Math.abs(corrected)).toBeLessThan(Math.abs(raw));
  });

  it('양수 증거도 같은 규칙으로 줄인다 — 한쪽만 깎으면 그 자체가 편향이다', () => {
    const cards = [
      card({ openedAt: 0, closedAt: 10 * DAY, info: 2 }),
      card({ openedAt: 0, closedAt: 10 * DAY, info: 2 }),
    ];
    expect(aggregateEvidence(cards).KR_EQUITY).toBeCloseTo(2, 10);
  });

  it('보정 기준에 결과(info)가 들어가지 않는다 — 결과를 보고 깎으면 새 악용 경로다', () => {
    // 같은 시각 구조인데 info만 다른 두 입력이 같은 하중을 받는다
    const shape = (i1: number, i2: number) =>
      aggregateEvidence([
        card({ openedAt: 0, closedAt: 10 * DAY, info: i1 }),
        card({ openedAt: 0, closedAt: 10 * DAY, info: i2 }),
      ]).KR_EQUITY;
    expect(shape(-4, -2)).toBeCloseTo(-3, 10);
    expect(shape(-2, -4)).toBeCloseTo(-3, 10);
  });
});

describe('보정 방식', () => {
  it('도메인은 겹친 비율(OVERLAP)을 쓴다', () => {
    expect(CORRELATION_CORRECTION).toBe('OVERLAP');
  });

  it('NONE은 단순 합 — 보정 전후를 비교하는 시뮬용 경로다', () => {
    const cards = [card({ info: -1 }), card({ openedAt: DAY, info: -1 })];
    expect(aggregateEvidence(cards, 'NONE').KR_EQUITY).toBeCloseTo(-2, 10);
  });

  it('MEAN은 옛 묶음 방식 — 연쇄 결함을 재현하는 시뮬용 경로로만 남는다', () => {
    const chained = [
      card({ openedAt: 0, closedAt: 10 * DAY, info: -3 }),
      card({ openedAt: 9 * DAY, closedAt: 20 * DAY, info: -3 }),
      card({ openedAt: 19 * DAY, closedAt: 30 * DAY, info: -3 }),
    ];
    expect(aggregateEvidence(chained, 'MEAN').KR_EQUITY).toBeCloseTo(-3, 10);
  });

  it('FIRST는 먼저 게시된 한 장만 센다', () => {
    const cards = [
      card({ openedAt: 0, closedAt: 10 * DAY, info: -1 }),
      card({ openedAt: DAY, closedAt: 10 * DAY, info: -9 }),
    ];
    expect(aggregateEvidence(cards, 'FIRST').KR_EQUITY).toBeCloseTo(-1, 10);
  });

  it('카드가 없으면 모든 자산군이 0', () => {
    const e = aggregateEvidence([]);
    expect(e.KR_EQUITY).toBe(0);
    expect(e.US_EQUITY).toBe(0);
    expect(e.CRYPTO).toBe(0);
  });
});
