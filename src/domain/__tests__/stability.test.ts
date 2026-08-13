import { describe, expect, it } from 'vitest';
import {
  cardStabilityLevel,
  estimateDailySigma,
  MAX_RETURN_SAMPLES,
  MIN_RETURN_SAMPLES,
  parkinsonSigma,
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
  it('조용할수록 별이 많다 — 실측 앵커가 앉는 자리 (2026-08-13, estimateDailySigma)', () => {
    expect(stabilityLevel(0.0131)).toBe(5); // 코카콜라
    expect(stabilityLevel(0.0248)).toBe(5); // 엔비디아 (경계 2.50% 바로 아래)
    expect(stabilityLevel(0.0431)).toBe(3); // NAVER
    expect(stabilityLevel(0.0592)).toBe(2); // 삼성전자
    expect(stabilityLevel(0.0704)).toBe(2); // SK하이닉스 — 경계 7.05% 바로 아래
    expect(stabilityLevel(0.182)).toBe(1); // 퓨즈머신즈 — 표본에서 가장 거친 축
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

describe('parkinsonSigma — 고가·저가로 잰 변동성', () => {
  it('같은 σ를 재는 다른 추정량이다 — 종가 σ와 대체로 같은 값을 낸다', () => {
    // 하루 ±2% 폭으로 오르내리는 종가열 + 그 폭에 맞는 고가·저가
    const closes: number[] = [100];
    const highs: number[] = [];
    const lows: number[] = [];
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) {
      const r = (rnd() - 0.5) * 0.07; // 하루 로그수익률
      const prev = closes[closes.length - 1];
      const next = prev * Math.exp(r);
      closes.push(next);
      highs.push(Math.max(prev, next) * 1.004);
      lows.push(Math.min(prev, next) * 0.996);
    }
    const close = realizedDailySigma(closes)!;
    const park = parkinsonSigma(highs, lows)!;
    // 같은 과정을 재므로 자릿수가 같아야 한다 (추정량이 다르니 정확히 같지는 않다)
    expect(park).toBeGreaterThan(close * 0.4);
    expect(park).toBeLessThan(close * 2.5);
  });

  it('장중 폭이 벌어지면 종가가 제자리여도 잡아낸다 — 이것이 쓰는 이유다', () => {
    const flat = Array.from({ length: 20 }, () => 100);
    const wide = parkinsonSigma(
      flat.map(() => 105),
      flat.map(() => 95),
    )!;
    const narrow = parkinsonSigma(
      flat.map(() => 100.2),
      flat.map(() => 99.8),
    )!;
    expect(wide).toBeGreaterThan(narrow * 10);
  });

  it('거래 없던 날은 빼고, 표본이 모자라면 null', () => {
    expect(parkinsonSigma([105, 106], [95, 96])).toBeNull();
    const h = Array.from({ length: 10 }, () => 105);
    const l = Array.from({ length: 10 }, () => 95);
    expect(parkinsonSigma(h, l, Array.from({ length: 10 }, () => 0))).toBeNull();
  });
});

describe('estimateDailySigma — 채점·하한·별점이 함께 쓰는 σ', () => {
  const bars = (closeSigma: 'calm', wideRange: boolean) => {
    void closeSigma;
    const closes: number[] = [];
    for (let i = 0; i < 130; i++) closes.push(100 * (1 + (i % 2 ? 0.002 : -0.002)));
    const highs = closes.map((c) => c * (wideRange ? 1.05 : 1.001));
    const lows = closes.map((c) => c * (wideRange ? 0.95 : 0.999));
    return { closes, highs, lows, volumes: closes.map(() => 1000) };
  };

  it('주식: 장중 폭이 벌어지면 종가 σ 대신 그것을 쓴다 (더 큰 쪽)', () => {
    const quiet = estimateDailySigma(bars('calm', false), 'KR_EQUITY')!;
    const coiled = estimateDailySigma(bars('calm', true), 'KR_EQUITY')!;
    expect(coiled).toBeGreaterThan(quiet * 3);
  });

  it('코인은 Parkinson을 쓰지 않는다 — 장중 되돌림이 커 구조적으로 과대해진다', () => {
    const wide = bars('calm', true);
    expect(estimateDailySigma(wide, 'CRYPTO')).toBeCloseTo(realizedDailySigma(wide.closes)!, 12);
  });

  it('고가·저가가 없으면 종가 σ로 물러선다', () => {
    const b = bars('calm', true);
    expect(estimateDailySigma({ closes: b.closes, volumes: b.volumes }, 'US_EQUITY')).toBeCloseTo(
      realizedDailySigma(b.closes)!,
      12,
    );
  });

  it('종가 σ를 낼 수 없으면(거래 부재) Parkinson이 커도 null이다', () => {
    const flat = Array.from({ length: 130 }, () => 100);
    expect(
      estimateDailySigma(
        { closes: flat, highs: flat.map(() => 110), lows: flat.map(() => 90) },
        'KR_EQUITY',
      ),
    ).toBeNull();
  });

  it('추정값은 종가 σ보다 작아지지 않는다 — 보수적인 방향으로만 움직인다', () => {
    for (const wide of [true, false]) {
      const b = bars('calm', wide);
      const close = realizedDailySigma(b.closes, b.volumes)!;
      expect(estimateDailySigma(b, 'US_EQUITY')!).toBeGreaterThanOrEqual(close - 1e-12);
    }
  });
});
