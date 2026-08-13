import { type AssetClass, type Direction, type Outcome, type TargetType } from './constants';

// 인투빌 점수 산정 모델 vmax — 정보량(로그 점수) 모델
// (2026-08-13 확정. 등급의 유일한 기준)
//
// **이름은 SCORE_MODEL_NAME 하나에서만 나온다** — 화면 문구가 여기를 읽는다.
// 버전 문자열을 화면에 손으로 적으면 모델이 바뀔 때 한쪽만 고치게 되고,
// 그러면 구매자가 보는 이름과 실제로 돌아가는 식이 갈라진다.
//
// ── 뼈대: 카드는 배팅이 아니라 확률 예보다 ──────────────────────────
// 신뢰도는 곧 확률 신고이고(claimedProbability), 점수는 그 신고가 무정보보다
// 얼마나 위였는지를 잰다:
//
//   적중: +S · w · ln( p̂ / p₀ )        실패: +S · w · ln( (1−p̂) / (1−p₀) )
//   S = SCORE_SCALE(100) · w = 수익성 가중(1.0~2.0) · p̂ = 신고 확률
//
// 수학적 성질 (유도는 아래 각 함수 주석, 검증은 scoring.test.ts·simScoreModel.ts):
//  · **적정(proper)**: 기대값이 p̂ = 진짜 확률에서 최대 — 정직 신고가 유일한 최적.
//    부풀리면 틀렸을 때 더 잃고, 낮추면 맞았을 때 덜 받는다
//  · 무실력자 기대값 = **−D(p₀‖p̂) ≤ 0** — 확신을 신고하는 순간 음수라
//    "은신처"를 따로 막을 장치가 필요 없다 (c=1은 아예 0이라 폐지, CONFIDENCE_RANGE)
//  · 실력자 기대값 = **+D(p‖p₀)** — 그 사람이 시장에 더한 정보량 그 자체
//  · **카드당 점수가 유계** — 이것이 v4를 버린 이유다(아래)
//  · 실패 벌점이 **게시 시점에 확정**된다 (p₀·p̂ 모두 카드 사양의 함수) — 리서처가
//    자기 하방을 정확히 알고 게시한다. "얼마나 크게 틀렸나"는 점수에 안 들어간다
//    (주장이 이항이므로) — 실현 등락은 기록·표시만 된다
//
// ── 왜 v4(공정배당 이항)를 버렸나 ───────────────────────────────────
// v4는 적중 +B·c·(1−p₀) / 실패 −B·c(c+1)/2·p₀ 였다. 유인 구조는 옳았지만
// **분산**이 문제였다: 벌점이 c(c+1)/2·B로 폭발해 크게 거는 사람의 아래 꼬리가
// 깊어졌고, 그 결과 "점수가 낮다"가 "실력이 없다"를 뜻하지 못했다.
// 실측(scripts/simSkillSeparation.ts): 준수형 하위 5%가 −3,354인데 무실력자의
// 최악은 −189였다 — 규율을 걸면 벌받는 쪽이 스팸이 아니라 운 나쁜 실력자였다.
// vmax로 바꾼 뒤 두 분포의 꼬리가 겹치지 않는다(준수형 p5 +177 / 스팸 p95 −30).
// (v3(거리 기반 연속 모델)은 판정 규칙 통합으로 안정성 측정 대상이 사라지며 폐기됐다)
//
// 안정성(s)은 **점수에서 제거**된 채다. 도달 판정에서 측정 대상이 없다.
// (후속 후보: "경로 안정성" — 목표 가는 길의 최대 역행폭 배팅. 별도 설계 필요)
//
// 실현 판정 불가·철회: 0점 (표본 제외). **정보량도 0** — 증거가 아니다.

/**
 * 이 모델의 이름 — 화면·문서·감사 로그가 전부 이 값을 읽는다.
 *
 * 왜 이름을 상수로 두나: 점수 모델은 등급의 유일한 기준이라 **어떤 규칙으로 채점됐는지**가
 * 구매자·리서처 양쪽에 남아야 한다. 이름이 화면마다 손으로 적혀 있으면 모델을 고칠 때
 * 한쪽만 바뀌고, 그러면 "무엇으로 채점했는가"에 두 개의 답이 생긴다.
 */
export const SCORE_MODEL_NAME = '인투빌 점수 산정 모델 vmax';

/**
 * 신뢰도 범위 — **하한이 2다** (2026-08-13 사용자 확정, vmax에서 근거가 바뀌었다).
 *
 * v4에서는 c=1이 "기대값 0인 은신처"였다 — 벌지는 못하지만 잃지도 않는 자리.
 * **vmax에서는 그보다 강하다: c=1의 점수는 항상 정확히 0이다.**
 * 사다리 배수가 140^((1−1)/9) = ×1.00이라 p̂ = p₀, 즉 "내 확률은 무정보와 같다"는
 * 신고이고, 그러면 ln(p̂/p₀) = ln((1−p̂)/(1−p₀)) = 0이다. 맞아도 0점, 틀려도 0점 —
 * 기대값이 아니라 **실현값**이 0이다(분산조차 없다).
 *
 * 그래서 막는 이유가 뒤집혔다. 파밍은 vmax가 스스로 막았고, 남는 문제는 이것이다:
 *  · **규율 래더가 닿지 못한다** — 정보량 기여가 정확히 0이라 몇 장을 내든 증거가
 *    한 톨도 쌓이지 않는다. 래더가 구조적으로 표적 삼을 수 없는 유일한 카드다
 *  · **위험 없이 팔린다** — 다른 모든 게시는 점수를 건다. c=1만 걸지 않는다.
 *    등급을 지키며 판매량만 늘리고 싶은 사람에게 공짜 슬롯이 된다
 *  · **상품이 성립하지 않는다** — c=1은 "나는 우위가 없다"를 명시적으로 신고하는
 *    카드다. 우위를 주장하지 않는 글의 자리는 이미 있다(무료 시황)
 *  · 별점도 구별하지 못한다 — confidenceStars가 클램프에 걸려 c=2와 같은 ★1이 된다
 *
 * 즉 하한 2는 이제 점수 방어 장치가 아니라 **참가 조건**이다: 팔려면 점수를 걸어야 한다.
 */
export const CONFIDENCE_RANGE = { min: 2, max: 10 } as const;

/**
 * 정보량(내추럴 로그)을 사람이 읽는 점수로 옮기는 배수.
 * 분리력에는 영향이 없다 — 단조 변환일 뿐이라 순위도 등급 비율도 그대로다.
 * 100인 이유는 카드 한 장이 대략 −200 ~ +500 범위에 들어와 읽기 좋기 때문이다.
 */
export const SCORE_SCALE = 100;

/**
 * 수익성 5구간의 기준 단위 F (domain/profitability.ts) — **하한이 아니다.**
 *
 * 2026-08-13까지 이 상수가 예측 크기 하한을 겸했는데, 두 역할은 분리해야 한다:
 *  · 하한은 "무정보로도 닿는 크기"를 막는 장치라 **종목 변동성에 따라 움직여야** 한다
 *    (아래 minMagnitudePct)
 *  · 수익성 라벨은 "맞으면 얼마나 버나"라 **절대 크기**여야 한다 — 종목마다 F가 달라지면
 *    "수익성 적극"이 삼성전자에서 10%, 테마주에서 40%를 뜻하게 되어 구매자가 라벨에서
 *    기대할 수 있는 것이 사라진다
 * 하나의 상수가 둘을 겸하면 한쪽을 고칠 때 다른 쪽이 조용히 따라 움직인다.
 */
export const PROFITABILITY_BASE_PCT: Record<AssetClass, number> = {
  KR_EQUITY: 5,
  US_EQUITY: 5,
  CRYPTO: 10,
};

/**
 * 예측 크기 하한의 비례 상수 — 하한 = k · σ · √(기한).
 *
 * ── 왜 σ·√H에 비례하는가 (수학) ──────────────────────────────
 * 무정보 도달 확률 p₀는 로그 장벽 거리를 확산 규모 σ√H로 나눈 **정규화 거리**의 함수다
 * (반사원리 — noSkillTouchProbability). 하한을 k·σ√H로 두면 그 정규화 거리가 항상 k로
 * 고정되므로 **∂p₀/∂σ ≈ 0** — 어떤 종목을 골라도 하한 카드의 무정보 적중률이 같아진다.
 * 이것이 "변동성으로만 hit을 노릴 수 없다"의 정확한 진술이다.
 * 고정 %는 이 성질이 없었다 (실측: 고정 5%의 p₀가 σ 0.8%→6.0%에서 21.7%→76.3%).
 *
 * ── k = 1.2인 근거 (scripts/simMagnitudeFloor.ts) ─────────────
 * "실력자 EV 최대화"는 기준이 못 된다 — 실력을 드리프트로 보면 우위가 √기간으로 커져
 * 최적 k가 기간에 따라 1.1→2.5로 움직인다. 그래서 **적중률 표시가 실력의 신호로
 * 남는가**로 골랐다: 시즌 20장에서 "승률 50% 이상"으로 보일 확률(이항 꼬리).
 *
 *   k      무정보자        준수 실력자   (σ=2.1%, 30일)
 *   0.8    15.3%          99.5%
 *   1.0     2.9%          95.4%
 *   1.2     0.3%          82.5%   ← 무릎
 *   1.4     0.0%          56.8%
 *   1.6     0.0%          28.8%
 *
 * 1.2 아래로는 무정보자가 운으로 실력처럼 보이고, 위로는 진짜 실력자가 자기 실력을
 * 표시하지 못한다. 기간을 3~180일로 바꿔도 같은 자리에서 갈린다(무정보 ≤1%).
 * 부수 효과로 파밍 이득이 54.6%p → 1.2%p로 닫히고, 단타 하한이 완화된다
 * (대형주 3일: 5% → 4.4%). 몬테카를로 4만 경로로 닫힌꼴 p₀를 검증(오차 ≤1.1%p).
 */
export const MAGNITUDE_FLOOR_K = 1.2;

/**
 * 절대 바닥(%) — 왕복 거래비용(수수료·세금·호가 스프레드)이 국내 주식 기준 0.2%대라,
 * 그 다섯 배는 되어야 "따라 매매해서 남는" 조언이 된다. σ가 아주 작은 종목의
 * 초단기 카드가 0.5%짜리 목표로 내려앉는 것을 막는 상품 성립선이다.
 */
export const ABSOLUTE_MIN_MAGNITUDE_PCT = 1;

/**
 * 하한과 상한 사이에 최소한 남겨야 하는 여지.
 *
 * σ가 아주 큰 종목(주식 기준 σ > 7.6%)에서는 하한(∝σ√H)이 고정 상한(∝√H)을 넘어
 * **게시 가능한 크기가 하나도 없어진다** — 둘 다 √H로 스케일해 기간을 늘려도 열리지 않는다.
 *
 * 하한을 눌러 창을 만드는 방법은 쓰지 않는다. 눌린 하한은 그 종목에서 무정보 도달
 * 확률을 다시 올려 **정확히 파밍이 노리는 자리에 구멍을 낸다**(테스트가 이 회귀를 잡는다).
 * 대신 **상한을 밀어 올린다**: σ=10%인 종목이 30일에 66% 움직이는 것은 실제로 통상
 * 변동폭 안이라, 그 종목에서 고정 상한 50%가 틀린 값이다.
 */
const FLOOR_CAP_RATIO = 0.7;

/**
 * 자산군별 일 변동성 σ̄ (거래일 기준) — **종목 σ를 모를 때만 쓰는 폴백**.
 *
 * 원래는 이 상수가 p₀의 유일한 입력이었는데, 그러면 **종목별 변동성 차익**이 남는다:
 * 실제 σ가 σ̄보다 큰 종목은 진짜 도달 확률이 모델 p₀보다 높아, 거친 종목만 골라
 * 쓰는 것만으로 기대 점수가 양수가 된다(실력 없이 변동성만으로 hit 사냥).
 * 그래서 게시 시점에 그 종목의 실현 변동성을 재서 카드에 고정하고(sigmaDaily),
 * p₀는 그 값으로 계산한다 — 같은 값이 안정성 별점의 원천이기도 하다
 * (domain/stability.ts: 한 번 재서 두 곳이 읽는다).
 */
export const DAILY_SIGMA: Record<AssetClass, number> = {
  KR_EQUITY: 0.02,
  US_EQUITY: 0.02,
  CRYPTO: 0.04,
};

/**
 * 종목 σ의 허용 범위 — 데이터 사고(0에 가까운 σ, 정지 종목의 평평한 종가열)가
 * p₀를 0이나 1로 붕괴시키지 않게 한다. **눌러 담는 클램프가 아니다**:
 * 실제로 거친 종목은 거친 대로 반영돼야 변동성 차익이 닫힌다.
 */
const SIGMA_MIN = 0.002;
const SIGMA_MAX = 0.25;

/**
 * 일봉(이산) 관측 보정 — Broadie–Glasserman–Kou 장벽 이동 계수.
 * 연속 반사원리 공식은 장중 터치까지 세지만 우리 판정은 종가만 보므로,
 * 장벽을 β·σ만큼 밀어 이산 관측의 도달 확률로 근사한다 (MC 대비 오차 ~1%p 검증).
 */
const BARRIER_SHIFT_BETA = 0.5826;

/** p₀ 안전 클램프 — 극단 크기에서 지급·벌점이 0으로 붕괴하지 않게 */
const P0_MIN = 0.01;
const P0_MAX = 0.95;

/**
 * 30일 기준 예측 크기(%) 상한 — 초안.
 *
 * 하한만 있고 상한이 없으면 "삼성전자 1주일 +80%" 같은 카드를 막을 수 없다.
 * 점수는 어차피 낮게 나오지만, 리포트 목록에는 "+80% 전망"이라는 자극적인 문구가
 * 걸리고 구매자는 그 숫자를 보고 산다 — 달성 불가능한 크기는 그 자체로 낚시다.
 */
export const MONTHLY_MAGNITUDE_CAP_PCT: Record<AssetClass, number> = {
  KR_EQUITY: 50,
  US_EQUITY: 50,
  CRYPTO: 120,
};

/**
 * 기간을 반영한 크기 상한.
 * 변동성은 시간의 제곱근에 비례하므로(랜덤워크) 30일 기준 상한을 √(일수/30)로 스케일한다.
 * 고정 상한을 쓰면 단기 카드에는 너무 헐겁고 장기 카드에는 너무 빡빡해진다.
 */
export function maxMagnitudePct(
  assetClass: AssetClass,
  horizonDays: number,
  /**
   * 그 종목의 실현 변동성. 주면 상한이 **하한 위로 밀려 올라간다** — 아주 거친 종목에서
   * 고정 상한이 하한 아래로 내려앉아 게시 가능한 크기가 사라지는 것을 막는다.
   * 안 주면 자산군 고정 상한 그대로 (검수 규칙처럼 σ를 모르는 자리).
   */
  sigmaDaily?: number | null,
): number {
  const days = Math.max(1, horizonDays);
  const fixed = MONTHLY_MAGNITUDE_CAP_PCT[assetClass] * Math.sqrt(days / 30);
  if (sigmaDaily == null) return fixed;
  return Math.max(fixed, rawMagnitudeFloor(assetClass, sigmaDaily, days) / FLOOR_CAP_RATIO);
}

/** 클램프 전 하한 — 상한 계산과 서로를 부르지 않게 따로 둔다 */
function rawMagnitudeFloor(
  assetClass: AssetClass,
  sigmaDaily: number | null | undefined,
  horizonDays: number,
): number {
  const sigma =
    sigmaDaily == null
      ? DAILY_SIGMA[assetClass]
      : Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, sigmaDaily));
  return MAGNITUDE_FLOOR_K * sigma * Math.sqrt(Math.max(1, horizonDays)) * 100;
}

/**
 * 예측 크기(%) 하한 — **그 종목의 실현 변동성과 기한으로 정해진다.**
 *
 * 하한 = clamp(k · σ · √기한 · 100, 절대 바닥, 상한 × 0.7)
 *
 * σ를 못 쟀으면 자산군 σ̄로 물러선다 (p₀ 폴백과 같은 규칙) — 지어내지 않되 계산은 계속된다.
 * 그 경우 하한은 종목이 아니라 자산군의 평균적 거칢을 반영하므로, σ가 큰 종목에서는
 * 파밍이 일부 열린다 (결측 치유 배치가 σ를 메우는 이유다 — server/cardDataHealer).
 */
export function minMagnitudePct(
  assetClass: AssetClass,
  sigmaDaily: number | null | undefined,
  horizonDays: number,
): number {
  // 위로는 누르지 않는다 — 누르는 순간 그 종목의 무정보 도달 확률이 올라
  // 파밍이 노리는 자리에 구멍이 생긴다. 상한이 대신 밀려 올라간다(maxMagnitudePct)
  return Math.max(
    ABSOLUTE_MIN_MAGNITUDE_PCT,
    rawMagnitudeFloor(assetClass, sigmaDaily, horizonDays),
  );
}

/**
 * 수익성 5구간의 경계 — 자산군 기준 단위 F의 배수.
 * (profitability.ts가 이 값을 읽는다. 여기 두는 이유는 점수의 크기 가중이 같은
 *  구간을 쓰기 때문 — 두 곳에 적어 두면 언젠가 갈라진다.)
 */
export const PROFITABILITY_BOUNDS = [1.5, 2, 3, 5] as const;

/** 예측 크기 → 수익성 구간 1~5 */
export function magnitudeLevel(assetClass: AssetClass, magnitudePct: number): 1 | 2 | 3 | 4 | 5 {
  const multiple = magnitudePct / PROFITABILITY_BASE_PCT[assetClass];
  return (1 + PROFITABILITY_BOUNDS.filter((b) => multiple >= b).length) as 1 | 2 | 3 | 4 | 5;
}

/**
 * 수익성 구간의 **대표 배수** — 그 구간 카드가 적중했을 때 실제로 버는 크기가
 * 기준 단위 F의 몇 배인가. 구간의 기하 중점을 쓴다(경계가 등비에 가까워 산술
 * 중점은 위쪽을 과소평가한다). 마지막 구간은 열려 있어(≥5F) 바로 아래 구간과
 * 같은 로그 폭을 위로 이어 붙인다.
 *
 * 점수 가중(magnitudeWeight)과 별점 환산(ratingStars.profitabilityPayoutStars)이
 * 같은 눈금을 써야 해서 여기 한곳에 둔다.
 */
export const PROFITABILITY_PAYOUT_MULTIPLE: Record<1 | 2 | 3 | 4 | 5, number> = (() => {
  const edges = [1, ...PROFITABILITY_BOUNDS];
  const last = PROFITABILITY_BOUNDS[PROFITABILITY_BOUNDS.length - 1];
  const openTop = last * (last / PROFITABILITY_BOUNDS[PROFITABILITY_BOUNDS.length - 2]);
  const uppers = [...PROFITABILITY_BOUNDS, openTop];
  const mids = edges.map((lo, i) => Math.sqrt(lo * uppers[i]));
  return { 1: mids[0], 2: mids[1], 3: mids[2], 4: mids[3], 5: mids[4] };
})();

/**
 * 수익성이 점수에 실리는 무게 — 1.00 ~ 2.00, **크기에 연속**이다.
 *
 * **완만한 이유**: 목표가 클수록 어렵다는 사실은 이미 p₀에 들어 있다(큰 목표 = 작은 p₀
 * = 적중 시 큰 로그비). 여기서 크기를 다시 곱하면 v4의 "크게 걸면 점수도 크다"가
 * 되살아나 아래 꼬리가 깊어진다. 시뮬에서 가중을 1~2로 두든 1~5로 두든 분리력은
 * 같았으므로(AUC 0.954 vs 0.950), 부작용이 작은 쪽을 고른다.
 *
 * **연속인 이유 (2026-08-13, 외부 검토 지적 → 실측 확인)**: 예전에는 수익성 5구간
 * 번호로 계단을 만들었다(1 + 0.25·(구간−1)). 그러면 구간 경계에서 목표를 0.02%p
 * 올리는 것만으로 기대 점수가 뛴다 — 실측으로 경계마다 **+25.3% / +20.2% / +16.7%
 * / +14.2%**. 분석과 무관한 순수 차익이고 막을 장치가 없었다.
 *
 * 구간화는 원래 **표시·마스킹**을 위한 것이지 채점을 위한 것이 아니었다. 수익성
 * 별점(5구간 정수)은 그대로 두고 채점 가중만 연속으로 편다 — 구간 폭이 최소
 * 주식 2.5%p라 라벨에서 원값을 역산할 수 없다는 성질은 별점 쪽에 그대로 남는다.
 *
 * 눈금은 구간 대표 배수의 로그 보간이라 구간 체계와 어긋나지 않는다.
 */
export function magnitudeWeight(assetClass: AssetClass, magnitudePct: number): number {
  const multiple = magnitudePct / PROFITABILITY_BASE_PCT[assetClass];
  const lo = Math.log(PROFITABILITY_PAYOUT_MULTIPLE[1]);
  const hi = Math.log(PROFITABILITY_PAYOUT_MULTIPLE[5]);
  const t = (Math.log(Math.max(1e-9, multiple)) - lo) / (hi - lo);
  return 1 + Math.min(1, Math.max(0, t));
}

// ── 표준정규 CDF (Abramowitz–Stegun 7.1.26, |오차| < 1.5e−7) ──────────
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * 무정보 도달 확률 p₀ — 마팅게일 GBM(로그 드리프트 −σ²/2)이 기한 H일 안에
 * 일봉 종가로 목표에 닿을 확률의 닫힌꼴 근사.
 *
 * 유도: 로그 공간에서 X_t = ν·t + σ·W_t, 장벽 거리 a = |ln(1 ± M/100)|.
 * 드리프트 있는 브라운 운동의 최초 도달 확률 (반사원리):
 *   P(τ_a ≤ T) = Φc((a − ν_eff·T)/(σ√T)) + e^{2·ν_eff·a/σ²} · Φc((a + ν_eff·T)/(σ√T))
 * 방향은 ν_eff에만 들어간다: 상승 장벽은 ν_eff = −σ²/2 (마팅게일 드리프트가 불리),
 * 하락 장벽은 ν_eff = +σ²/2 (유리) — 그래서 같은 M이라도 하락 카드의 p₀가 약간 크다.
 * 종가만 관측하므로 장벽을 β·σ 이동(BGK 보정)해 이산 관측으로 근사한다.
 *
 * 정확도: 몬테카를로(일봉 GBM) 대비 오차 1%p 안팎 — simTouchIncentives.ts가 검증.
 */
export function noSkillTouchProbability(
  direction: Direction,
  magnitudePct: number,
  assetClass: AssetClass,
  horizonDays: number,
  /**
   * 그 종목의 실현 변동성 (게시 시점 측정값, PredictionCard.sigmaDaily).
   * null·미지정이면 자산군 σ̄로 물러선다 — 지어내지 않되 계산은 계속된다.
   */
  sigmaInput?: number | null,
): number {
  if (magnitudePct <= 0) throw new Error(`예측 크기는 양수여야 합니다: ${magnitudePct}`);
  const sigmaDaily =
    sigmaInput == null
      ? DAILY_SIGMA[assetClass]
      : Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, sigmaInput));
  const T = Math.max(1, horizonDays);
  const ratio = magnitudePct / 100;
  // 하락 카드의 로그 장벽 거리: |ln(1 − M/100)|. M ≥ 100%는 하락으로 불가능(게시 검증)
  const a =
    direction === 'UP' ? Math.log(1 + ratio) : Math.abs(Math.log(Math.max(1e-9, 1 - ratio)));
  const aEff = a + BARRIER_SHIFT_BETA * sigmaDaily; // 이산 관측 보정
  const nu = direction === 'UP' ? -0.5 * sigmaDaily * sigmaDaily : 0.5 * sigmaDaily * sigmaDaily;
  const sqrtT = Math.sqrt(T);
  const denom = sigmaDaily * sqrtT;
  const p =
    1 -
    normalCdf((aEff - nu * T) / denom) +
    Math.exp((2 * nu * aEff) / (sigmaDaily * sigmaDaily)) *
      (1 - normalCdf((aEff + nu * T) / denom));
  return Math.min(P0_MAX, Math.max(P0_MIN, p));
}

// ══ 신뢰도 사다리 — 승산 증폭 ═══════════════════════════════════════
//
// 신뢰도 c의 뜻은 그대로다: **"내 승산이 무정보의 몇 배인가."**
// 바뀐 것은 칸의 간격이다. 예전에는 c배(선형, 꼭대기 10배)였는데, 실측한 실력 분포가
// 그 범위를 한참 넘는다 (scripts/simConfidenceLevels.ts):
//   정밀 ×137.6 / 우수 ×31.5 / 준수 ×5.5 / 하위 ×2.0 / 무실력 ×1.0
// 꼭대기 10배로는 **최상위 실력자가 자기 우위의 1/14도 신고하지 못해** 우수형과
// 구별되지 않았다. 신고 해상도(진짜 승산과 신고 승산의 로그 오차)로 재면
// 꼭대기가 ×16일 때 0.58, ×140일 때 0.08 — 일곱 배 차이다.
//
// **칸 수는 10으로 유지한다.** 칸 수를 바꿀 근거가 없었다: 범위를 고정하고 칸 수만
// 흔들면 분리력이 잡음(±0.002)의 수십 배로 튀고, 연속 신고(무한 칸)가 7칸보다 낮게
// 나오는 모순까지 생긴다 — 격자 정렬의 우연이다. 같은 범위에서는 칸이 많을수록
// 신고가 정확해지므로(이론과 실측 일치) 10칸이 7칸보다 못할 이유가 없다.

/** 신뢰도 최고 칸의 승산 배수 — 실측 최상위 실력(×137.6)을 덮는다 */
export const CONFIDENCE_ODDS_TOP = 140;

/** 신뢰도 c → 승산 배수. 등비 사다리(칸당 약 ×1.71)라 별점이 c에 선형이 된다 */
export function confidenceOddsMultiple(confidence: number): number {
  const { min, max } = CONFIDENCE_RANGE;
  void min;
  return Math.pow(CONFIDENCE_ODDS_TOP, (confidence - 1) / (max - 1));
}

const oddsOf = (p: number) => p / Math.max(1e-9, 1 - p);
const probOf = (o: number) => o / (1 + o);

/** 신고 확률의 상한 — ln(p̂/p₀)가 무한대로 가지 않게 (100% 신고는 허용하지 않는다) */
export const CLAIMED_PROB_CAP = 0.97;

/**
 * 신뢰도 c가 함의하는 적중 확률 p̂ — 무정보 승산을 c칸만큼 증폭한 값.
 * 이것이 리서처가 사실상 신고하는 확률이고, 점수는 이 신고의 정확도를 잰다.
 */
export function claimedProbability(p0: number, confidence: number): number {
  return Math.min(CLAIMED_PROB_CAP, probOf(oddsOf(p0) * confidenceOddsMultiple(confidence)));
}

/**
 * 정직한 신뢰도 — 자기 승산이 무정보의 몇 배인지를 사다리 칸으로 되돌린다.
 * 화면(점수 계산기·작성 화면)이 "이 확신이면 신뢰도 몇이 정직한가"를 보여줄 때 쓴다.
 */
export function honestConfidence(pTrue: number, p0: number): number {
  const multiple = oddsOf(pTrue) / Math.max(1e-9, oddsOf(p0));
  const c = 1 + ((CONFIDENCE_RANGE.max - 1) * Math.log(Math.max(1, multiple))) / Math.log(CONFIDENCE_ODDS_TOP);
  return Math.min(CONFIDENCE_RANGE.max, Math.max(CONFIDENCE_RANGE.min, Math.round(c)));
}

export interface ReachScore {
  /** 무정보 도달 확률 — 게시 사양(방향·크기·기간·자산군)만의 함수 */
  p0: number;
  /** 신뢰도가 함의하는 적중 확률 */
  claimed: number;
  /** 기준 대비 정보량 (스케일·가중 적용 전) */
  info: number;
  /** 최종 점수 */
  score: number;
}

/**
 * vmax 본체 — **기준 대비 로그 점수(정보량)**.
 *
 *   적중:  ln( p̂ / p₀ )        실패:  ln( (1−p̂) / (1−p₀) )
 *
 * 이 양은 "이 예보가 무정보 대비 정보를 얼마나 더했는가"다. 성질:
 *  · **적정(proper)**: 기대값이 p̂ = 진짜 확률에서 최대 — 정직 신고가 유일한 최적
 *  · **무실력자의 기대값 = −D(p₀‖p̂) ≤ 0**, 등호는 p̂ = p₀(=신뢰도 최저)일 때뿐.
 *    확신을 신고하는 순간 음수가 되므로 "은신처"를 따로 막을 필요가 없다
 *  · **실력자의 기대값 = D(p‖p₀)** — 그 사람이 시장에 더한 정보량 그 자체
 *  · **카드당 점수가 유계다.** v4는 벌점이 c(c+1)/2·B로 폭발해 크게 거는 사람의
 *    아래 꼬리가 깊어졌고, 그래서 "점수가 낮다"가 "실력이 없다"를 뜻하지 못했다
 *    (실측: 준수형 하위 5%가 −3,354인데 무실력자의 최악은 −189였다)
 *
 * 수익성(크기)은 정보량에 **완만한 가중**으로만 들어간다 — 난이도는 이미 p₀에 반영돼
 * 있어 크기를 다시 곱하면 v4의 "크게 걸면 점수도 크다"가 되살아난다.
 */
export function computeReachScore(
  direction: Direction,
  magnitudePct: number,
  confidence: number,
  assetClass: AssetClass,
  horizonDays: number,
  hit: boolean,
  /** 그 종목의 실현 변동성 — 없으면 자산군 σ̄ */
  sigmaDaily?: number | null,
): ReachScore {
  assertConfidence(confidence);
  const p0 = noSkillTouchProbability(direction, magnitudePct, assetClass, horizonDays, sigmaDaily);
  const claimed = claimedProbability(p0, confidence);
  const info = hit ? Math.log(claimed / p0) : Math.log((1 - claimed) / (1 - p0));
  const weight = magnitudeWeight(assetClass, magnitudePct);
  return { p0, claimed, info, score: SCORE_SCALE * weight * info };
}

// ── 규율 래더 (자산군별·시즌별 적용) ──────────────────────────────
//
// **vmax 재설계 (2026-08-13, scripts/simDisciplineLadder.ts).** 래더 자체는 v3 이후
// 손대지 않았는데, 그 아래의 점수 모델이 두 번 바뀌면서 두 곳이 동시에 어긋나 있었다.
//
// ① 처방이 거꾸로였다 — 옛 래더는 **최소 신뢰도를 올렸다.** v4에서는 벌점이 c(c+1)/2로
//    커져 "자신 없으면 아예 내지 마라"는 억제였지만, vmax에서 그것은 **플랫폼이 거짓 신고를
//    요구하는 것**이 된다(적정 점수법에서 신뢰도는 곧 확률 신고다). 게다가 표적인
//    과장 신고자는 이미 c를 높게 부르고 있어 하한이 아무 제약도 되지 못한다 —
//    실측: 발동해도 그들이 파는 ★4+ 카드가 20.0장 그대로였다(규율 없을 때와 동일).
//    그래서 **상한**으로 뒤집었다. 낮게 부르는 것은 언제나 가능하므로 거짓말을 강요하지
//    않고, 표적의 판매 신호(별점)를 정확히 겨눈다.
//
// ② 문턱이 임의였다 — 이제는 고를 필요가 없다. **vmax 점수는 이미 로그우도비다:**
//    카드의 정보량 합 D = ln( L(신고한 확률) / L(무정보) ). 신고가 정직하면 1/Λ는
//    평균 1의 비음 마팅게일이라 Ville 부등식이 그대로 온다:
//
//        P( 시즌 중 언젠가라도 D ≤ −ln(1/α) )  ≤  α          (신고가 정직할 때)
//
//    **표본 수와 무관하게, 어느 시점에 봐도** 성립한다 — 최소 표본도, 다중 검정 보정도
//    필요 없다. 문턱이 곧 오작동 확률의 상한이라, 각 단이 "정직한 사람을 잘못 잡을
//    확률"을 이름으로 달고 있다. 시뮬레이션은 이 값을 고르는 데 쓰이지 않았고
//    **검증에만** 쓰였다(실측 오작동 3.7% / 0.5% — 각 단의 α 이내).
//
// 쓰는 값이 점수(score)가 아니라 **정보량(info)**인 이유: 수익성 가중 w는 상품의
// 값어치지 증거가 아니다. 큰 목표를 걸었다고 같은 적중이 더 강한 증거가 되지는 않는다.
//
// ⚠ **정보량을 그냥 더하면 안 된다.** Ville 부등식은 각 항이 그때까지 드러난 결과를
// 알고 낸 조건부 신고일 때 성립하는데, 같은 기간에 함께 열려 있는 상관된 카드
// (예: 반도체 3종목 상승)는 그 조건을 깬다 — 셋이 함께 맞고 함께 틀리는데 합은
// 세 번의 독립 증거로 센다. 실측으로 정직한 신고자의 1단 오작동이 3.6% → 41.3%까지
// 벌어졌다. 그래서 집계는 **domain/evidence.ts의 aggregateEvidence**를 거쳐,
// 카드마다 자기와 겹친 기간만큼 하중을 나눠 센다.
//
// 회복은 자동이다 — D는 현재값의 함수라 이후 적중으로 올라오면 상한이 풀린다.
//
// ⚠ **D는 시즌으로 끊지 않는다** (2026-08-13, server/scoreService 주석). 점수·등급은
// 분기마다 0에서 시작하지만 증거는 이어 쌓는다. 상관 보정 뒤 한 시즌의 유효 장수가
// 2.6장이라 리셋하면 래더가 아예 발동하지 못했고(실측 표적 발동 0.0%), Ville은
// anytime-valid라 창을 늘려도 보장이 그대로다 — 오히려 분기 리셋이 연 4α의
// 다중 검정을 만들고 있었다.

export interface Discipline {
  /** 작성 가능한 **최대** 신뢰도 (CONFIDENCE_RANGE.max면 제약 없음) */
  maxConfidence: number;
  /** 해당 자산군 신규 게시 정지 여부 */
  publishSuspended: boolean;
}

/**
 * 각 단의 오작동 상한 α — 문턱은 −ln(1/α)로 유도된다.
 *
 * ── 1단이 10%인 이유 (2026-08-13, scripts/simEvidenceChaining.ts ⑧⑩) ──
 * 상관 보정(evidence.ts)을 넣은 뒤 정직한 신고자의 실측 오작동이 **전 시나리오
 * 0.00%** 가 됐다. 진짜 상관을 최악(ρ=1.0)까지 올려도 0.00%다. 목표가 5%인데
 * 0%라는 것은 **쓰지 않는 α를 지불하고 있다**는 뜻이고, 대가가 한 자리에 몰린다:
 *
 *     유효 3.5장 × 카드당 −0.806 = −2.82   >   1단 문턱 −3.00
 *
 * 경미한 과장(무실력 + c=5)이 **한 눈금 차이로** 문턱에 닿지 못해 탐지 0%였다.
 * c=7·c=10은 잡히는데 c=5만 구조적으로 못 잡는 자리였다.
 *
 * 여유를 쓰는 길은 둘인데, 수학적으로는 같은 일이고 **말할 수 있는 보장이 다르다**:
 *  · 하중식을 완화(ρ̄<1) — 실측 1.50%로 안전하지만 보장이 **구성에서 실측으로 강등**된다
 *  · **α를 올린다** — Ville은 어떤 α에서도 구성으로 성립하므로 보장을 잃지 않는다
 * 실측이 사실상 같은 지점이라(오작동 1.50% vs 1.54%, c=5 45% vs 45%) 후자를 골랐다.
 *
 *   1단 α    문턱     실측 오작동   c=10   c=7   c=5
 *     5%    −3.00       0.00%       98%   79%    0%
 *    10%    −2.30       1.54%       99%   89%   45%   ← 채택
 *    20%    −1.61       5.89%       99%   96%   68%
 *
 * **1단만 올린다.** 1단은 처분이 가장 가볍고(게시 정지가 아니라 신뢰도 상한 6 —
 * 여전히 팔 수 있다) 탐지의 관문이다. 깊은 단은 처분이 무거우므로 증거 요구가
 * 강해야 한다 — 시장 충격 국면에서 정직한 리서처가 게시 정지를 당하는 것이
 * 이 사다리에서 가장 비싼 오작동이다.
 */
export const DISCIPLINE_ALPHA = [0.1, 0.01, 0.001, 0.0001] as const;

/** α → 증거 문턱. Ville 부등식의 경계 그 자체다 */
export function evidenceThreshold(alpha: number): number {
  return -Math.log(1 / alpha);
}

export const DISCIPLINE_LADDER: ReadonlyArray<
  { evidenceBelow: number; alpha: number } & Discipline
> = [
  // 깊은 단부터 — disciplineFor가 위에서부터 훑는다
  { alpha: 0.0001, evidenceBelow: evidenceThreshold(0.0001), maxConfidence: 2, publishSuspended: true },
  { alpha: 0.001, evidenceBelow: evidenceThreshold(0.001), maxConfidence: 2, publishSuspended: false },
  { alpha: 0.01, evidenceBelow: evidenceThreshold(0.01), maxConfidence: 4, publishSuspended: false },
  { alpha: 0.1, evidenceBelow: evidenceThreshold(0.1), maxConfidence: 6, publishSuspended: false },
];

/**
 * 자산군별 시즌 누적 **정보량** → 현재 적용되는 규율.
 * (점수가 아니라 정보량이다 — Judgment.info의 합)
 */
export function disciplineFor(assetClassEvidence: number): Discipline {
  for (const rung of DISCIPLINE_LADDER) {
    if (assetClassEvidence <= rung.evidenceBelow) {
      return { maxConfidence: rung.maxConfidence, publishSuspended: rung.publishSuspended };
    }
  }
  return { maxConfidence: CONFIDENCE_RANGE.max, publishSuspended: false };
}

function assertConfidence(confidence: number, label = '신뢰도'): void {
  if (confidence < CONFIDENCE_RANGE.min || confidence > CONFIDENCE_RANGE.max) {
    throw new Error(`${label}는 ${CONFIDENCE_RANGE.min}~${CONFIDENCE_RANGE.max}입니다: ${confidence}`);
  }
}

/** 목표가형 카드의 예측 크기(%) 환산: 기준가 대비 목표가 거리 */
export function targetPriceToMagnitudePct(targetPrice: number, basePrice: number): number {
  if (basePrice <= 0) throw new Error(`기준가가 유효하지 않습니다: ${basePrice}`);
  return (Math.abs(targetPrice - basePrice) / basePrice) * 100;
}

/**
 * 위의 역 — 수익률형 카드가 가리키는 목표가.
 * 구매자가 산 것은 "8%"라는 비율이 아니라 "198,000원이 178,200원까지"라는 주장이라,
 * 구매 후 화면은 이 숫자를 보여준다. 화면에서 곱셈을 하지 않고 여기 두는 이유는
 * targetPriceToMagnitudePct와 **서로의 역이어야** 하기 때문 — 둘이 갈라지면
 * 화면이 말한 목표가와 채점이 쓴 크기가 어긋난다(테스트가 왕복을 강제한다).
 */
export function magnitudePctToTargetPrice(
  basePrice: number,
  direction: Direction,
  magnitudePct: number,
): number {
  if (basePrice <= 0) throw new Error(`기준가가 유효하지 않습니다: ${basePrice}`);
  const signed = direction === 'UP' ? magnitudePct : -magnitudePct;
  return basePrice * (1 + signed / 100);
}

export interface JudgedCardScoreInput {
  direction: Direction;
  targetType: TargetType;
  /** 예측 크기: RETURN_PCT는 등락률(%), TARGET_PRICE는 목표가 */
  targetValue: number;
  confidence: number;
  /** 자산군 — 종목 σ가 없을 때의 폴백 변동성 결정 */
  assetClass: AssetClass;
  /**
   * 게시 시점에 잰 종목 실현 변동성 — p₀의 입력.
   * 게시 순간 카드에 고정되므로, 도달 판정이든 기한 판정이든 같은 σ로 채점된다
   * (리서처가 게시할 때 본 배당표가 판정까지 그대로 유지된다).
   */
  sigmaDaily: number | null;
  /** 기준가 (소급 확정 후 값). 없으면 점수 0 */
  basePrice: number | null;
  /** 판정 종가 — 실현 등락 기록·표시용 (v4 점수는 적중 여부만 쓴다) */
  settledPrice: number | null | undefined;
  /** 게시→검증 시한 일수 — p₀의 입력. 게시일이 없으면 호출자가 계산 불가 → 0점 처리 */
  horizonDays: number | null;
  outcome: Outcome;
}

/**
 * 판정 결과 → 실현 등락률·점수 (§2.2). 판정 불가·데이터 결측은 0점(표본 제외).
 * 배치·수동 판정이 카드별로 호출한다.
 */
export function scoreJudgedCard(input: JudgedCardScoreInput): {
  realizedReturnPct: number | null;
  score: number;
  /** 가중 전 정보량 = 로그우도비 기여분 — 규율 래더가 이것을 합산한다 */
  info: number;
  /** 방향·크기 성분 = v4 총점 (감사·화면 표시용) */
  directionScore: number;
  /** @deprecated v4에서 항상 0 — 경로 안정성 배팅 재설계 전까지 */
  stabilityScore: number;
} {
  if (
    input.outcome === 'UNDECIDABLE' ||
    input.settledPrice == null ||
    !input.basePrice ||
    input.horizonDays == null
  ) {
    return { realizedReturnPct: null, score: 0, info: 0, directionScore: 0, stabilityScore: 0 };
  }
  const realizedReturnPct = ((input.settledPrice - input.basePrice) / input.basePrice) * 100;
  const predictedMagnitudePct =
    input.targetType === 'RETURN_PCT'
      ? input.targetValue
      : targetPriceToMagnitudePct(input.targetValue, input.basePrice);
  const { score, info } = computeReachScore(
    input.direction,
    predictedMagnitudePct,
    input.confidence,
    input.assetClass,
    input.horizonDays,
    input.outcome === 'HIT',
    input.sigmaDaily,
  );
  return { realizedReturnPct, score, info, directionScore: score, stabilityScore: 0 };
}
