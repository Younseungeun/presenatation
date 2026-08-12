// 안정성 — 리서처 자기 신고가 아니라 **종목의 실측 변동성으로 시스템이 매기는** 표시 지표.
//
// 이력: v3까지는 자기 신고 다이얼(selfStability)이 점수의 정밀도 배팅이었다.
// v4(공정배당 이항)에서 점수 기여가 사라지자 다이얼과 별점을 걷어냈는데, 그 결과
// 카드의 확신 상자가 두 칸이 되어 "이 예측이 가는 길이 얼마나 험한가"를 말해 주는
// 축이 없어졌다. 그래서 같은 이름의 별점을 **자기 신고 없이** 되살린다:
// 종목의 최근 실현 변동성(일봉 로그수익률 표준편차)을 5구간으로 접은 값이다.
//
// 세 별점이 서로 다른 축을 맡는다 — 겹치면 어느 별이 무엇을 말하는지 흐려진다:
//   · 수익성  = 맞으면 얼마나 버나 (광고 수익률의 크기, profitability.ts)
//   · 신뢰도  = 얼마나 맞을 것 같나 (리서처가 건 승산, 함의 승률로 표시)
//   · 안정성  = 가는 길이 얼마나 출렁이나 (종목 변동성 — 이 파일)
//
// 점수 산정에는 **일절 들어가지 않는다** (별점 평균에서도 제외 — marketQueries).
// 리서처가 조작할 수 없는 값이라 "공짜 마케팅 칸" 문제(자기 신고 별점의 폐지 사유)가
// 재발하지 않는다.
//
// 구간은 자산군 공통의 **절대 눈금**이다 — 수익성이 자산군 하한 F로 정규화하는 것과
// 반대인데, 의도적이다: 수익성의 질문("얼마나 공격적인가")은 자산군 안에서의 상대
// 위치가 답이지만, 안정성의 질문("보유 기간에 얼마나 흔들리나")은 계좌가 겪는 절대
// 등락이 답이다. 코인이 대체로 별이 적은 것은 왜곡이 아니라 사실의 전달이다.

/** 하루 로그수익률 표준편차 → 별 구간 경계. 대략 ×1.7 등비 — 변동성은 로그 정규에 가깝다 */
export const STABILITY_SIGMA_BOUNDS = [0.01, 0.018, 0.03, 0.05] as const;

export type StabilityLevel = 1 | 2 | 3 | 4 | 5;

/**
 * 표본 하한 — 이보다 짧은 이력(신규 상장 등)으로 만든 σ는 표시하지 않는다.
 * 20거래일(약 한 달)은 추정 표준오차 σ/√(2n) ≈ 16%로, 5구간 분류가 한 칸 이상
 * 흔들리지 않는 최소선이다.
 */
export const MIN_RETURN_SAMPLES = 20;

/** σ 계산에 쓰는 최대 표본 — 최근 60거래일(약 3개월). 더 길면 "최근"이 아니게 된다 */
export const MAX_RETURN_SAMPLES = 60;

/**
 * 일봉 종가열 → 실현 변동성 (하루 로그수익률의 표본 표준편차).
 * 종가는 과거 → 최근 순서로 준다. 표본이 모자라면 null — 어림값을 지어내지 않는다.
 */
export function realizedDailySigma(closes: readonly number[]): number | null {
  const usable = closes.filter((c) => Number.isFinite(c) && c > 0);
  const recent = usable.slice(-(MAX_RETURN_SAMPLES + 1));
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.log(recent[i] / recent[i - 1]));
  }
  if (returns.length < MIN_RETURN_SAMPLES) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

/** 실현 변동성 → 안정성 5구간. 조용할수록 별이 많다 */
export function stabilityLevel(sigmaDaily: number): StabilityLevel {
  let level = 5;
  for (const bound of STABILITY_SIGMA_BOUNDS) {
    if (sigmaDaily >= bound) level--;
  }
  return level as StabilityLevel;
}

/**
 * 카드에 저장된 σ → 별. σ가 없으면(신규 상장·시세 조회 실패·백필 전 카드) null —
 * 자산군 평균으로 대신 그리면 "이 종목의 안정성"이라는 라벨이 거짓말이 된다.
 */
export function cardStabilityLevel(sigmaDaily: number | null | undefined): StabilityLevel | null {
  return sigmaDaily == null ? null : stabilityLevel(sigmaDaily);
}
