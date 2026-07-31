import { describe, expect, it } from 'vitest';
import {
  blocksNewCard,
  hasRiskDisclosure,
  instrumentRiskReasons,
  isRiskAtLeast,
  MIN_MARKET_CAP,
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

describe('게시 보류를 유발하는 종목 위험', () => {
  const base = { assetClass: 'KR_EQUITY' as const, riskLevel: 'NONE' as const };

  it('위험 신호가 없으면 사유도 없다', () => {
    expect(instrumentRiskReasons({ ...base, marketCap: 5_000_000_000_000 })).toEqual([]);
  });

  it('투자주의·투자경고 지정은 보류 사유', () => {
    expect(instrumentRiskReasons({ ...base, riskLevel: 'CAUTION' })[0].code).toBe('MARKET_ALERT');
    const warned = instrumentRiskReasons({
      ...base,
      riskLevel: 'WARNING',
      riskNote: 'KRX 투자경고',
    });
    expect(warned[0].code).toBe('MARKET_ALERT');
    expect(warned[0].message).toContain('KRX 투자경고');
  });

  it('상장폐지 가능성은 보류 사유 (판정 불가로 끝날 위험)', () => {
    const r = instrumentRiskReasons({ ...base, delistingRisk: true });
    expect(r[0].code).toBe('DELISTING_RISK');
    expect(r[0].message).toContain('판정이 불가능');
  });

  it('시총이 자산군 기준 미만이면 보류 사유', () => {
    const small = instrumentRiskReasons({ ...base, marketCap: 45_000_000_000 }); // 450억
    expect(small[0].code).toBe('SMALL_CAP');
    expect(small[0].message).toContain('450억원');
    expect(small[0].message).toContain('1,000억원');

    // 기준 이상은 사유 없음
    expect(instrumentRiskReasons({ ...base, marketCap: MIN_MARKET_CAP.KR_EQUITY })).toEqual([]);
    // 시총 정보가 없으면 판단하지 않는다 (공급자 미지원 자산군)
    expect(instrumentRiskReasons({ ...base, marketCap: null })).toEqual([]);
  });

  it('자산군마다 시총 기준이 다르다 (미국은 달러)', () => {
    expect(
      instrumentRiskReasons({ assetClass: 'US_EQUITY', riskLevel: 'NONE', marketCap: 200_000_000 }),
    ).toHaveLength(1);
    expect(
      instrumentRiskReasons({ assetClass: 'US_EQUITY', riskLevel: 'NONE', marketCap: 900_000_000 }),
    ).toEqual([]);
  });

  it('여러 위험이 겹치면 사유가 모두 쌓인다', () => {
    const r = instrumentRiskReasons({
      ...base,
      riskLevel: 'WARNING',
      delistingRisk: true,
      marketCap: 10_000_000_000,
    });
    expect(r.map((x) => x.code)).toEqual(['MARKET_ALERT', 'DELISTING_RISK', 'SMALL_CAP']);
  });

  it('DANGER는 보류가 아니라 차단이므로 사유에 넣지 않는다', () => {
    expect(instrumentRiskReasons({ ...base, riskLevel: 'DANGER' })).toEqual([]);
    expect(blocksNewCard('DANGER')).toBe(true);
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
