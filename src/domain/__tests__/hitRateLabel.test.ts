import { describe, expect, it } from 'vitest';
import { MIN_SAMPLE_FOR_RATE, MIN_SAMPLE_FOR_VERIFIED } from '../constants';
import { hitRateLabel, showsHitRate } from '../trackRecord';

// **어뷰징이 파는 것은 적중률이 아니라 "적중률 100%" 스크린샷 한 장이다.**
//
// 계정 둘로 같은 종목에 상승·하락을 걸면 하나는 반드시 적중하고, 실패한 쪽은 구매자가
// 전액 환불받아 항의하지 않으므로 버리는 값이 거의 없다. 정상적인 의견 차이와 구별할
// 수 없어 탐지로는 못 막는다 — 그래서 **값어치를 없앤다.**
//
// 표본 병기(우리의 오랜 원칙)는 캡처 한 장에는 남지 않는다. 숫자 자체를 안 내보내는
// 것이 유일한 방어이고, 그 규칙이 화면마다 흩어지면 빠진 한 곳이 캡처 대상이 된다.

describe('적중률 표시 규칙', () => {
  it('표본이 차기 전에는 숫자를 내보내지 않는다', () => {
    expect(hitRateLabel(1.0, 1)).toBe('검증 1/5건');
    expect(hitRateLabel(1.0, 2)).toBe('검증 2/5건'); // 양방향 베팅이 만드는 바로 그 모양
    expect(hitRateLabel(1.0, MIN_SAMPLE_FOR_RATE - 1)).toBe('검증 4/5건');
    expect(showsHitRate(1.0, 2)).toBe(false);
  });

  it('표본이 차면 숫자로 말한다', () => {
    expect(hitRateLabel(1.0, MIN_SAMPLE_FOR_RATE)).toBe('100.0%');
    expect(hitRateLabel(0.621, 47)).toBe('62.1%');
    expect(hitRateLabel(0.621, 47, { digits: 0 })).toBe('62%');
    expect(showsHitRate(0.621, 47)).toBe(true);
  });

  it('판정이 아예 없으면 진행도가 아니라 "판정 전"이다 — 0/5는 실패한 것처럼 읽힌다', () => {
    expect(hitRateLabel(null, 0)).toBe('판정 전');
    expect(hitRateLabel(null, 0, { none: '아직 판정된 예측이 없어요' })).toBe(
      '아직 판정된 예측이 없어요',
    );
  });

  // 두 문턱은 **묻는 것이 다르다** — 하나로 합치면 둘 중 하나가 틀린다
  it('표시 문턱과 검증 문턱은 다른 질문이다', () => {
    expect(MIN_SAMPLE_FOR_RATE).toBeLessThan(MIN_SAMPLE_FOR_VERIFIED);
    // 5~9건: 숫자는 보여주되 "검증 중"이고 등수도 없다
    expect(showsHitRate(0.8, 5)).toBe(true);
    expect(5 < MIN_SAMPLE_FOR_VERIFIED).toBe(true);
  });
});
