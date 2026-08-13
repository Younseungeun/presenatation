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
//   · 신뢰도  = 얼마나 맞을 것 같나 (리서처가 신고한 적중 확률 — 별은 c에 선형)
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

/**
 * 하루 로그수익률 표준편차 → 별 구간 경계.
 *
 * **눈금은 짐작이 아니라 실측 분포에서 온다** (scripts/calibrateStability.ts).
 *
 * 2026-08-13 재산정 — 표본 126 → **300종목**, σ 창 60 → 120거래일:
 *  · **규모를 고르게 담는다**: 거래대금(=규모 대리변수, 마스터에 시가총액이 없다)
 *    5분위에서 같은 수씩 뽑는다. 무작위로 뽑으면 유니버스의 대다수인 소형주가
 *    표본을 채워 눈금이 소형주 기준으로 밀린다
 *  · **주식이 아닌 것을 뺀다**: 레버리지·인버스(leveragedProduct)에 더해
 *    채권·우선주·SPAC(nonEquityProduct). 이전 판의 "가장 조용한 종목" 상위가
 *    전부 이것들이었다 — 구조적으로 안 움직여 ★5 구간을 통째로 차지했다
 *  · **거래 없는 날을 뺀다**: 거래량 0인 날의 종가는 체결이 아니라 직전 값이라
 *    거기서 잰 "0% 변동"은 조용한 것이 아니라 측정이 없는 것이다
 *
 * 결과 점유율 ★1~★5 각 20%. 익숙한 이름들이 앉는 자리: 코카콜라·JP모건·비트코인 ★5,
 * 엔비디아 ★4, NAVER ★3, 삼성전자·현대차·인텔 ★2, SK하이닉스 ★1.
 *
 * 시장 국면이 바뀌면 같은 스크립트를 다시 돌려 이 네 숫자만 갈아 끼운다.
 */
export const STABILITY_SIGMA_BOUNDS = [0.024, 0.0335, 0.0475, 0.0655] as const;

export type StabilityLevel = 1 | 2 | 3 | 4 | 5;

/**
 * 표본 하한 — 이보다 짧은 이력(신규 상장 등)으로 만든 σ는 표시하지 않는다.
 * 20거래일(약 한 달)은 추정 표준오차 σ/√(2n) ≈ 16%로, 5구간 분류가 한 칸 이상
 * 흔들리지 않는 최소선이다.
 */
export const MIN_RETURN_SAMPLES = 20;

/**
 * σ 계산에 쓰는 최대 표본 — 최근 **120거래일**(약 6개월).
 *
 * 60일에서 늘렸다 (2026-08-13). 60일은 한 분기의 국면을 통째로 물고 들어와
 * 하한과 별점이 시장 상황을 따라 크게 출렁였다 — 실측으로 삼성전자가 급락·급등이
 * 겹친 분기에 σ 6.72%(연 107%)로 잡혀 30일 카드 하한이 44%까지 올라갔다.
 * 표본을 두 배로 늘리면 그런 분기 하나의 무게가 절반이 되고, 추정 표준오차도
 * σ/√(2n) 기준 9.1% → 6.5%로 줄어든다.
 *
 * 더 늘리지 않는 이유: 변동성은 국면을 타므로 1년치를 쓰면 "최근"이 아니게 된다.
 * (KIS 일봉은 한 번에 100건이라 120일은 2회 호출이다 — kisProvider.pagedDaily)
 */
export const MAX_RETURN_SAMPLES = 120;

/**
 * 종가가 실제로 움직인 날의 최소 비율. 이보다 낮으면 σ를 내지 않는다.
 * 거래정지·정리매매·SPAC 유닛처럼 며칠씩 같은 값이 이어지는 종목을 걸러낸다 —
 * 그런 종목의 낮은 σ는 "안정적"이 아니라 "거래가 없다"는 뜻이다.
 * 0.6은 넉넉한 선이다: 정상 종목은 종가가 같은 날이 거의 없고(≈1.0),
 * 정지 종목은 0에 가깝다.
 */
export const MIN_MOVING_RATIO = 0.6;

/**
 * 일봉 종가열 → 실현 변동성 (하루 로그수익률의 표본 표준편차).
 * 종가는 과거 → 최근 순서로 준다. 표본이 모자라면 null — 어림값을 지어내지 않는다.
 */
export function realizedDailySigma(
  closes: readonly number[],
  /**
   * 같은 날의 거래량 (있으면). **거래가 없던 날은 표본에서 뺀다** — 그날 종가는
   * 체결이 아니라 직전 값이 남은 것이라, 거기서 잰 "0% 변동"은 조용한 것이 아니라
   * 측정이 없는 것이다. 종가 움직임 비율(MIN_MOVING_RATIO)보다 직접적인 기준이라
   * 거래량이 있으면 이쪽을 먼저 쓴다.
   */
  volumes?: readonly number[],
): number | null {
  const pairs = closes.map((c, i) => ({ c, v: volumes?.[i] }));
  const usable = pairs
    .filter((p) => Number.isFinite(p.c) && p.c > 0)
    .filter((p) => p.v === undefined || p.v > 0)
    .map((p) => p.c);
  const recent = usable.slice(-(MAX_RETURN_SAMPLES + 1));
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.log(recent[i] / recent[i - 1]));
  }
  if (returns.length < MIN_RETURN_SAMPLES) return null;

  // **움직이지 않는 종가열은 σ가 아니라 거래 부재의 신호다.**
  // 거래정지 종목·SPAC 유닛·초저유동 종목은 종가가 며칠씩 그대로라 σ가 0에 수렴하고,
  // 그대로 두면 "가장 안정적인 종목"으로 분류된다(실측: 캘리브레이션 표본의 최하위가
  // 전부 정지·SPAC이었다). 안정성 별점의 뜻이 "조용하다"가 아니라 "안 팔린다"가 된다.
  // 값을 지어내지 않고 null을 돌려준다 — 화면은 "—", 점수는 자산군 σ̄로 물러선다.
  const moved = returns.filter((r) => r !== 0).length;
  if (moved < returns.length * MIN_MOVING_RATIO) return null;

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
