import { describe, expect, it } from 'vitest';
import {
  blocksNewCard,
  hasRiskDisclosure,
  isRiskAtLeast,
  requiresRiskDisclosure,
  riskBlockMessage,
  toRiskLevel,
} from '../instrumentRisk';

// 위험 종목 선별은 "우리가 위험하다고 판단"하는 게 아니라 거래소 지정을 반영한다.
// 등급별로 무엇이 달라지는지를 테스트로 고정한다.

describe('등급 판정', () => {
  it('거래 위험(DANGER)만 신규 게시를 막는다', () => {
    expect(blocksNewCard('DANGER')).toBe(true);
    expect(blocksNewCard('WARNING')).toBe(false);
    expect(blocksNewCard('CAUTION')).toBe(false);
    expect(blocksNewCard('NONE')).toBe(false);
  });

  it('경고 이상은 리스크 고지를 요구한다 (주의는 표시만)', () => {
    expect(requiresRiskDisclosure('DANGER')).toBe(true);
    expect(requiresRiskDisclosure('WARNING')).toBe(true);
    expect(requiresRiskDisclosure('CAUTION')).toBe(false);
    expect(requiresRiskDisclosure('NONE')).toBe(false);
  });

  it('등급 비교는 순서를 따른다', () => {
    expect(isRiskAtLeast('WARNING', 'CAUTION')).toBe(true);
    expect(isRiskAtLeast('CAUTION', 'WARNING')).toBe(false);
    expect(isRiskAtLeast('NONE', 'NONE')).toBe(true);
  });

  it('차단 사유에는 종목과 판정 불가 위험이 함께 담긴다', () => {
    const msg = riskBlockMessage('123456', '위험종목', '관리종목 지정');
    expect(msg).toContain('위험종목(123456)');
    expect(msg).toContain('관리종목 지정');
    expect(msg).toContain('판정이 불가능');
  });
});

describe('공급자 신호 매핑', () => {
  it('거래지원 종료 > 유의 > 주의 순으로 우선한다', () => {
    expect(toRiskLevel({ delisting: true, warning: true, caution: true })).toBe('DANGER');
    expect(toRiskLevel({ warning: true, caution: true })).toBe('WARNING');
    expect(toRiskLevel({ caution: true })).toBe('CAUTION');
    expect(toRiskLevel({})).toBe('NONE');
    expect(toRiskLevel(undefined)).toBe('NONE');
  });
});

describe('리스크 고지 판정', () => {
  it('위험·변동성·손실 가능성을 언급하면 고지로 본다', () => {
    expect(hasRiskDisclosure('변동성이 매우 크므로 유의해야 합니다.')).toBe(true);
    expect(hasRiskDisclosure('원금 손실 가능성이 있습니다.')).toBe(true);
    expect(hasRiskDisclosure('하락 가능성도 열어둬야 합니다.')).toBe(true);
  });

  it('위험 언급이 전혀 없는 매수 일변도 본문은 고지 없음', () => {
    expect(hasRiskDisclosure('실적이 개선되어 상승을 전망합니다. 목표가 5만원.')).toBe(false);
  });
});
