import { describe, expect, it } from 'vitest';
import {
  cardStabilityLevel,
  MAX_RETURN_SAMPLES,
  MIN_RETURN_SAMPLES,
  realizedDailySigma,
  stabilityLevel,
  STABILITY_SIGMA_BOUNDS,
} from '../stability';

// 안정성 = 종목 실현 변동성의 5구간 — 자기 신고가 아니라 시스템 산정.
// 점수에는 들어가지 않는다 (marketQueries.ratingAverage에서 제외).

/** 하루 로그수익률이 정확히 ±sigma로 번갈아 나오는 종가열 */
function alternatingCloses(sigma: number, days: number): number[] {
  const closes = [100];
  for (let i = 0; i < days; i++) {
    closes.push(closes[closes.length - 1] * Math.exp(i % 2 === 0 ? sigma : -sigma));
  }
  return closes;
}

describe('realizedDailySigma — 일봉 종가열 → 하루 변동성', () => {
  it('±σ로 번갈아 움직이는 종가열의 실현 변동성은 σ에 수렴한다', () => {
    const sigma = realizedDailySigma(alternatingCloses(0.02, 60));
    // 표본 표준편차라 평균 보정(≈0)과 n−1 만큼 미세하게 다르다
    expect(sigma).not.toBeNull();
    expect(sigma!).toBeGreaterThan(0.019);
    expect(sigma!).toBeLessThan(0.021);
  });

  it('표본이 하한(20수익률) 미만이면 null — 어림값을 지어내지 않는다', () => {
    expect(realizedDailySigma(alternatingCloses(0.02, MIN_RETURN_SAMPLES - 1))).toBeNull();
    expect(realizedDailySigma([])).toBeNull();
    expect(realizedDailySigma([100])).toBeNull();
  });

  it('최근 60거래일만 쓴다 — 먼 과거의 급변동이 지금의 별을 흔들지 않는다', () => {
    // 앞 100일은 미친 변동(10%), 최근 61일은 조용(1%)
    const wild = alternatingCloses(0.1, 100);
    const calm = alternatingCloses(0.01, MAX_RETURN_SAMPLES);
    const merged = [...wild, ...calm.map((c) => (c / 100) * wild[wild.length - 1])];
    const sigma = realizedDailySigma(merged);
    expect(sigma!).toBeLessThan(0.02); // 조용한 최근만 반영됐다는 증거
  });

  it('0·음수·NaN 종가는 표본에서 뺀다 (데이터 오류가 σ를 오염시키지 않게)', () => {
    const closes = alternatingCloses(0.02, 60);
    closes.splice(10, 0, 0, NaN, -5);
    const sigma = realizedDailySigma(closes);
    expect(sigma!).toBeGreaterThan(0.019);
    expect(sigma!).toBeLessThan(0.021);
  });
});

describe('stabilityLevel — σ → 별 5구간 (실측 5분위, STABILITY_SIGMA_BOUNDS)', () => {
  it('조용할수록 별이 많다 — 실측 앵커가 앉는 자리 (2026-08-13, 120거래일)', () => {
    expect(stabilityLevel(0.0131)).toBe(5); // 코카콜라
    expect(stabilityLevel(0.0248)).toBe(4); // 엔비디아
    expect(stabilityLevel(0.0428)).toBe(3); // NAVER
    expect(stabilityLevel(0.0591)).toBe(2); // 삼성전자
    expect(stabilityLevel(0.0703)).toBe(1); // SK하이닉스
  });

  it('경계값은 아래 구간으로 (>= 경계 → 별 하나 감소)', () => {
    // 경계는 상수에서 읽는다 — 재캘리브레이션 때마다 숫자를 고쳐 적지 않게
    STABILITY_SIGMA_BOUNDS.forEach((bound, i) => {
      expect(stabilityLevel(bound)).toBe(4 - i);
    });
  });

  it('보통 대형주가 최하 구간에 떨어지지 않는다 — ★1은 유난히 거친 20%의 자리다', () => {
    // 이 성질이 눈금을 다시 잰 이유였다 (옛 눈금에서 인텔·NAVER가 ★1이었다)
    for (const sigma of [0.054, 0.0428, 0.0591]) {
      expect(stabilityLevel(sigma)).toBeGreaterThan(1);
    }
  });
});

describe('cardStabilityLevel — 저장값 → 별', () => {
  it('σ 미상이면 null — 자산군 평균으로 대신 그리지 않는다', () => {
    expect(cardStabilityLevel(null)).toBeNull();
    expect(cardStabilityLevel(undefined)).toBeNull();
  });

  it('σ가 있으면 stabilityLevel 그대로', () => {
    expect(cardStabilityLevel(0.03)).toBe(stabilityLevel(0.03));
  });
});
