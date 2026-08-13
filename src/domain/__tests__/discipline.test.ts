import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_RANGE,
  DISCIPLINE_ALPHA,
  DISCIPLINE_LADDER,
  claimedProbability,
  computeReachScore,
  disciplineFor,
  evidenceThreshold,
  noSkillTouchProbability,
} from '../scoring';
import { preparePublish, type CardDraft, type PublishConditions } from '../publishReport';

const NOW = new Date('2026-07-12T00:00:00Z');

const card: CardDraft = {
  assetClass: 'KR_EQUITY',
  ticker: '005930',
  assetName: '삼성전자',
  direction: 'UP',
  targetType: 'RETURN_PCT',
  targetValue: 10,
  deadline: new Date('2026-10-12T00:00:00Z'),
  confidence: 2, // 신뢰도 하한 (c=1은 무정보 EV가 0이라 폐지)
  selfStability: 5,
  // 이 테스트가 보는 것은 규율 래더지 크기 하한이 아니다 — 조용한 종목으로 고정해
  // 하한에 걸리지 않게 한다 (하한은 σ·기한의 함수다: scoring.minMagnitudePct)
  sigmaDaily: 0.005,
};

const cond: PublishConditions = {
  priceKrw: 20_000,
  prepaymentRatio: 0,
  tier: 'BRONZE',
  promoActive: false,
};

describe('문턱은 고른 값이 아니라 유도된 값이다', () => {
  it('각 단의 문턱 = −ln(1/α) — 오작동 상한이 곧 문턱이다', () => {
    expect(evidenceThreshold(0.05)).toBeCloseTo(-2.9957, 3);
    expect(evidenceThreshold(0.01)).toBeCloseTo(-4.6052, 3);
    expect(evidenceThreshold(0.001)).toBeCloseTo(-6.9078, 3);
    expect(evidenceThreshold(0.0001)).toBeCloseTo(-9.2103, 3);
  });

  it('래더의 모든 문턱이 α에서 유도된다 — 손으로 적은 숫자가 없어야 한다', () => {
    for (const rung of DISCIPLINE_LADDER) {
      expect(rung.evidenceBelow).toBeCloseTo(evidenceThreshold(rung.alpha), 12);
    }
    expect(DISCIPLINE_LADDER.map((r) => r.alpha)).toEqual([...DISCIPLINE_ALPHA].reverse());
  });

  it('깊을수록 α가 작다 — 무거운 처분일수록 더 확실할 때만', () => {
    for (let i = 1; i < DISCIPLINE_LADDER.length; i++) {
      expect(DISCIPLINE_LADDER[i].alpha).toBeGreaterThan(DISCIPLINE_LADDER[i - 1].alpha);
      expect(DISCIPLINE_LADDER[i].evidenceBelow).toBeGreaterThan(
        DISCIPLINE_LADDER[i - 1].evidenceBelow,
      );
    }
  });
});

describe('disciplineFor — 신뢰도 상한 래더', () => {
  it('증거가 없거나 얕으면 제약 없음', () => {
    expect(disciplineFor(0)).toEqual({
      maxConfidence: CONFIDENCE_RANGE.max,
      publishSuspended: false,
    });
    expect(disciplineFor(-2.9).maxConfidence).toBe(CONFIDENCE_RANGE.max);
  });

  it('증거가 쌓일수록 **상한이 내려간다** (올라가지 않는다)', () => {
    expect(disciplineFor(evidenceThreshold(0.05)).maxConfidence).toBe(6);
    expect(disciplineFor(evidenceThreshold(0.01)).maxConfidence).toBe(4);
    expect(disciplineFor(evidenceThreshold(0.001)).maxConfidence).toBe(2);
  });

  it('상한은 신뢰도 하한 아래로 내려가지 않는다 — 게시 자체가 불가능해지면 안 된다', () => {
    for (const d of [-3, -5, -7, -9, -20, -100]) {
      expect(disciplineFor(d).maxConfidence).toBeGreaterThanOrEqual(CONFIDENCE_RANGE.min);
    }
  });

  it('가장 깊은 단만 게시 정지', () => {
    expect(disciplineFor(evidenceThreshold(0.001)).publishSuspended).toBe(false);
    expect(disciplineFor(evidenceThreshold(0.0001)).publishSuspended).toBe(true);
  });

  it('적중이 쌓이면 자동으로 풀린다 — 현재 증거의 함수다', () => {
    expect(disciplineFor(-4.0).maxConfidence).toBe(6);
    expect(disciplineFor(-1.0).maxConfidence).toBe(CONFIDENCE_RANGE.max);
  });
});

describe('무엇을 재는가 — 점수가 아니라 정보량', () => {
  it('점수에는 수익성 가중이 붙지만 증거에는 붙지 않는다', () => {
    const small = computeReachScore('UP', 8, 5, 'KR_EQUITY', 30, false, 0.02);
    const big = computeReachScore('UP', 40, 5, 'KR_EQUITY', 30, false, 0.02);
    // score / info = SCORE_SCALE × 수익성 가중 — 큰 목표일수록 크다
    expect(big.score / big.info).toBeGreaterThan(small.score / small.info);
  });

  it('큰 목표를 놓친 것은 **약한** 증거다 — 어차피 닿기 어려웠으니까', () => {
    // 규율이 점수를 쓰면 이 사실이 뒤집힌다: 큰 목표의 실패가 가중 때문에
    // 더 무거운 벌로 세어져, 야심 찬 카드를 낸 사람이 먼저 걸린다.
    // 정보량은 난이도(p₀)만 보므로 그런 일이 없다.
    const small = computeReachScore('UP', 8, 5, 'KR_EQUITY', 30, false, 0.02);
    const big = computeReachScore('UP', 40, 5, 'KR_EQUITY', 30, false, 0.02);
    expect(big.p0).toBeLessThan(small.p0);
    expect(Math.abs(big.info)).toBeLessThan(Math.abs(small.info));
  });
});

describe('규율의 표적 — 거짓 신고', () => {
  const p0 = noSkillTouchProbability('UP', 10, 'KR_EQUITY', 30, 0.02);
  const infoAt = (c: number, hit: boolean) =>
    computeReachScore('UP', 10, c, 'KR_EQUITY', 30, hit, 0.02).info;

  it('크게 부르고 틀리면 한 장으로도 1단에 닿는다', () => {
    // c=10은 적중 확률 97%를 신고하는 것이다 — 한 번의 실패가 이미 강한 증거다
    expect(infoAt(10, false)).toBeLessThanOrEqual(evidenceThreshold(0.05));
  });

  it('정직하게 낮게 부르면 한두 번 틀려도 걸리지 않는다', () => {
    expect(infoAt(CONFIDENCE_RANGE.min, false) * 2).toBeGreaterThan(evidenceThreshold(0.05));
  });

  it('적중 한 번이 실패 여러 번을 되돌린다 — 확신이 맞으면 증거가 그만큼 강하다', () => {
    expect(infoAt(10, true)).toBeGreaterThan(0);
    expect(infoAt(10, true) + infoAt(10, false)).toBeGreaterThan(infoAt(10, false));
  });

  it('신고 확률이 실제와 맞으면 기대 증거가 0 이상 — 정직한 사람은 내려가지 않는다', () => {
    for (const c of [2, 5, 8, 10]) {
      const pHat = claimedProbability(p0, c);
      // 진짜 확률이 신고한 확률과 같을 때의 기대 정보량 = KL(p̂‖p₀) ≥ 0
      const expected = pHat * infoAt(c, true) + (1 - pHat) * infoAt(c, false);
      expect(expected).toBeGreaterThanOrEqual(0);
    }
  });

  it('무실력자가 확신을 부를수록 기대 증거가 가파르게 음수 — 표적이 스스로 걸어 들어온다', () => {
    const evAt = (c: number) => p0 * infoAt(c, true) + (1 - p0) * infoAt(c, false);
    expect(evAt(10)).toBeLessThan(evAt(5));
    expect(evAt(5)).toBeLessThan(evAt(CONFIDENCE_RANGE.min));
    expect(evAt(CONFIDENCE_RANGE.min)).toBeLessThan(0);
  });
});

describe('preparePublish 규율 연동', () => {
  it('증거가 얕으면 신뢰도 10도 통과', () => {
    expect(
      preparePublish({ ...card, confidence: 10 }, { ...cond, assetClassEvidence: -1 }, 70_000, NOW)
        .feeRateBp,
    ).toBe(2000);
  });

  it('1단: 신뢰도 7 이상 거부, 6은 허용', () => {
    expect(() =>
      preparePublish({ ...card, confidence: 7 }, { ...cond, assetClassEvidence: -3.5 }, 70_000, NOW),
    ).toThrow(/신뢰도 6 이하/);
    expect(
      preparePublish({ ...card, confidence: 6 }, { ...cond, assetClassEvidence: -3.5 }, 70_000, NOW)
        .feeRateBp,
    ).toBe(2000);
  });

  it('2단: 상한 4', () => {
    expect(() =>
      preparePublish({ ...card, confidence: 5 }, { ...cond, assetClassEvidence: -5 }, 70_000, NOW),
    ).toThrow(/신뢰도 4 이하/);
    expect(
      preparePublish({ ...card, confidence: 4 }, { ...cond, assetClassEvidence: -5 }, 70_000, NOW)
        .feeRateBp,
    ).toBe(2000);
  });

  it('3단: 상한이 하한과 같아진다 — ★1 카드만 남는다', () => {
    expect(() =>
      preparePublish({ ...card, confidence: 3 }, { ...cond, assetClassEvidence: -7 }, 70_000, NOW),
    ).toThrow(/신뢰도 2 이하/);
    expect(
      preparePublish(
        { ...card, confidence: CONFIDENCE_RANGE.min },
        { ...cond, assetClassEvidence: -7 },
        70_000,
        NOW,
      ).feeRateBp,
    ).toBe(2000);
  });

  it('4단: 신뢰도와 무관하게 게시 정지', () => {
    expect(() =>
      preparePublish(
        { ...card, confidence: CONFIDENCE_RANGE.min },
        { ...cond, assetClassEvidence: -12 },
        70_000,
        NOW,
      ),
    ).toThrow(/게시가 정지/);
  });

  it('증거 미제공(판정 이력 없음)이면 규율 미발동', () => {
    expect(preparePublish({ ...card, confidence: 10 }, cond, 70_000, NOW).feeRateBp).toBe(2000);
  });
});
