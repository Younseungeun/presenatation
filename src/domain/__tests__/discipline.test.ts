import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_RANGE,
  disciplineFor,
  computeReachScore,
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

describe('disciplineFor — 마이너스 점수 규율 래더', () => {
  it('0점 이상·얕은 마이너스는 제약 없음', () => {
    expect(disciplineFor(0)).toEqual({ minConfidence: CONFIDENCE_RANGE.min, publishSuspended: false });
    expect(disciplineFor(-999)).toEqual({ minConfidence: CONFIDENCE_RANGE.min, publishSuspended: false });
  });

  it('마이너스가 깊어질수록 최소 신뢰도 상승 (1단은 v3 완화: 3→2)', () => {
    expect(disciplineFor(-1_000).minConfidence).toBe(2);
    expect(disciplineFor(-3_000).minConfidence).toBe(5);
    expect(disciplineFor(-6_000).minConfidence).toBe(7);
  });

  it('-10,000 이하는 신규 게시 정지', () => {
    expect(disciplineFor(-10_000).publishSuspended).toBe(true);
  });

  it('점수가 회복되면 자동 완화 (현재 점수의 함수)', () => {
    expect(disciplineFor(-2_999).minConfidence).toBe(2);
    expect(disciplineFor(-500).minConfidence).toBe(CONFIDENCE_RANGE.min);
  });
});

describe('규율의 경제적 효과 — 저품질 대량 게시 차단', () => {
  /** 진짜 적중 확률 p인 사람이 신뢰도 c로 게시했을 때의 기대 점수 */
  const evAt = (p: number, c: number) =>
    p * computeReachScore('UP', 10, c, 'KR_EQUITY', 30, true, 0.02).score +
    (1 - p) * computeReachScore('UP', 10, c, 'KR_EQUITY', 30, false, 0.02).score;

  it('무실력자는 신뢰도를 올릴수록 손해가 커진다 — 적정 점수법이 스스로 막는다', () => {
    const p0 = noSkillTouchProbability('UP', 10, 'KR_EQUITY', 30, 0.02);
    // 진짜 확률이 p₀인 사람(= 무실력)이 확신을 신고하면 기대 정보량이 음수다
    expect(evAt(p0, CONFIDENCE_RANGE.min)).toBeLessThan(0);
    expect(evAt(p0, 5)).toBeLessThan(evAt(p0, CONFIDENCE_RANGE.min));
    expect(evAt(p0, 10)).toBeLessThan(evAt(p0, 5));
  });

  it('실력자는 강제 신뢰도 5에서도 기대 점수 + (하한의 선별성)', () => {
    expect(evAt(0.85, 5)).toBeGreaterThan(0);
  });
});

describe('preparePublish 규율 연동', () => {
  it('**래더 1단(-1,000 → c≥2)은 이제 아무 제약이 아니다** — 하한이 이미 2다', () => {
    // 신뢰도 하한이 2로 오르면서 1단이 전역 하한과 같아져 무효가 됐다.
    // 남겨 둔 이유는 래더의 다음 칸들이 그대로 유효하기 때문이고, 1단을 3으로 올릴지는
    // 게시 가능 인원이 바뀌는 운영 결정이라 값을 임의로 손대지 않았다.
    expect(
      preparePublish(card, { ...cond, assetClassScore: -1_500 }, 70_000, NOW).feeRateBp,
    ).toBe(2000);
  });

  it('점수 -3,000 이하: 신뢰도 5 미만 거부, 5면 허용 — 여기서부터 실제로 조인다', () => {
    expect(() =>
      preparePublish({ ...card, confidence: 4 }, { ...cond, assetClassScore: -3_500 }, 70_000, NOW),
    ).toThrow(/신뢰도 5 이상/);
    expect(
      preparePublish({ ...card, confidence: 5 }, { ...cond, assetClassScore: -3_500 }, 70_000, NOW)
        .feeRateBp,
    ).toBe(2000);
  });

  it('점수 -10,000 이하: 신뢰도와 무관하게 게시 정지', () => {
    expect(() =>
      preparePublish(
        { ...card, confidence: 10 },
        { ...cond, assetClassScore: -12_000 },
        70_000,
        NOW,
      ),
    ).toThrow(/게시가 정지/);
  });

  it('점수 미제공(집계 배치 전)이면 규율 미발동', () => {
    expect(preparePublish(card, cond, 70_000, NOW).feeRateBp).toBe(2000);
  });
});
