import { type AssetClass, type Direction, type Outcome, type TargetType } from './constants';

// 점수 산정 v4 — 공정배당 이항 모델 (2026-08-12 확정. 등급의 유일한 기준)
//
// ── 왜 v3(거리 기반 연속 모델)을 버렸나 ─────────────────────────────
// 판정 규칙이 "기한 내 일봉 종가 도달 = 적중"으로 통합되면서(judgment.ts) v3의
// 전제 두 개가 무너졌다 (실측: scripts/simTouchIncentives.ts):
//  ① 적중 시 판정가 = 목표가 → 실현 오차 ε ≡ 0 → 안정성이 항상 만점.
//     측정하던 것("착지 정밀도")이 사라졌는데 지급(최대 450점, 크기 무관)은 남아
//     — 준수 실력자 EV의 51%가 이 공짜 주머니에서 나오고, 최적 전략이
//     "하한 목표 + 안정성 만점 배팅"으로 미끄러졌다 (신뢰도와 완전 중첩)
//  ② 무정보 스팸의 EV가 +12~17점/장으로 양수 전환 — v3의 핵심 불변식
//     ("삼각부등식으로 스팸 구조적 음수")은 시한 종가 실현을 전제로 했는데,
//     도달 판정에서는 하한 목표의 무정보 도달 확률이 56~57%라 전제가 깨진다
//
// ── v4의 뼈대: 무정보 확률에 대한 공정배당 배팅 ─────────────────────
// 카드는 "기한 안에 종가로 목표에 닿는다"는 **이항 사건**에 대한 주장이다.
// 무정보 리서처(드리프트 0 기하 브라운 운동)의 도달 확률 p₀를 닫힌꼴로 계산하고,
// 그 확률의 공정 배당으로 걸게 한다:
//
//   적중: +B · c · (1 − p₀)          실패: −B · c(c+1)/2 · p₀
//   B = DIRECTION_SCALE × 예측 크기 M (%p)   — v3 스케일 계승
//
// 수학적 성질 (유도는 아래 각 함수 주석, 수치 검증은 simTouchIncentives.ts):
//  · 무정보 EV = −B·p₀(1−p₀)·c(c−1)/2 ≤ 0, c=1에서만 0
//    → 스팸이 어떤 (M, 기간, 자산군)을 골라도 구조적으로 못 번다.
//      c=1 은신처(EV=0)는 v3와 동일한 잔여 구멍 — 활성 카드 상한이 방어
//  · 정직한 신뢰도: c → c+1이 이득일 조건이 odds(p) ≥ (c+1)·odds(p₀)
//    (odds(x) = x/(1−x)) → 최적 c* = "무정보 대비 승산 배수".
//    신뢰도의 뜻이 v3의 모호한 증폭에서 **"내 승산이 몇 배인가"**로 명확해졌다
//  · 정직한 크기: EV = B(M)·c·(p−p₀) 꼴이라 하한 목표는 p₀가 커서(하한 30일
//    무정보 도달 ~56%) 공짜 몫을 빼고 나면 지급이 작다. 실력자의 최적 M은
//    내부점이고 실력과 함께 커진다 (시뮬 검증)
//  · 실패 벌점이 **게시 시점에 확정**된다 (p₀는 카드 사양의 함수) — 리서처가
//    자기 하방을 정확히 알고 게시한다. "얼마나 크게 틀렸나"는 점수에 안 들어간다
//    (주장이 이항이므로) — 실현 등락은 기록·표시만 된다
//
// 안정성(s)은 **점수에서 제거**됐다. 도달 판정에서 측정 대상이 없다.
// (후속 후보: "경로 안정성" — 목표 가는 길의 최대 역행폭 배팅. 별도 설계 필요)
//
// 실현 판정 불가·철회: 0점 (표본 제외).

/**
 * 신뢰도 범위 — **하한이 2다** (2026-08-13 사용자 확정).
 *
 * v4의 무정보 기대 점수는 −B·p₀(1−p₀)·c(c−1)/2 라서 **c=1에서만 정확히 0**이다.
 * 스팸이 벌지는 못하지만 잃지도 않는 은신처였고, 저품질 대량 게시의 동기는 점수가
 * 아니라 판매 수익이라 마이너스 규율도 발동하지 않았다. c≥2를 강제하면 그 자리가
 * 곧바로 음수가 되어 하강이 구조적으로 보장된다.
 *
 * 비용은 작다 (실측): 승산이 무정보의 1.5배인 약한 실력자의 기대 점수가
 * c=1에서 +0.073B, **c=2에서 +0.001B** — 이익이 거의 사라질 뿐 손해로 돌아서지는
 * 않는다. c=3부터가 −0.217B로 진짜 손해다. 즉 하한 2는 실력 있는 사람을
 * 밀어내지 않으면서 무정보자만 음수로 민다.
 *
 * 별점 스케일(ratingStars.confidenceStars)도 이 하한을 따라 다시 편다 —
 * 아무도 못 쓰는 c=1 자리가 별점의 바닥을 차지하고 있으면 실제로 쓰이는 구간이
 * 별 2.5~4.55의 좁은 위쪽에 몰린다.
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
 * 수익성이 점수에 실리는 무게 — 구간 1에서 1.00, 구간 5에서 2.00.
 *
 * **완만한 이유**: 목표가 클수록 어렵다는 사실은 이미 p₀에 들어 있다(큰 목표 = 작은 p₀
 * = 적중 시 큰 로그비). 여기서 크기를 다시 곱하면 v4의 "크게 걸면 점수도 크다"가
 * 되살아나 아래 꼬리가 깊어진다. 시뮬에서 가중을 1~2로 두든 1~5로 두든 분리력은
 * 같았으므로(AUC 0.954 vs 0.950), 부작용이 작은 쪽을 고른다.
 */
export function magnitudeWeight(assetClass: AssetClass, magnitudePct: number): number {
  return 1 + 0.25 * (magnitudeLevel(assetClass, magnitudePct) - 1);
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
 * v5 본체 — **기준 대비 로그 점수(정보량)**.
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

// ── 마이너스 점수 규율 (자산군별 적용) ─────────────────────────────
// 누적 점수가 깊은 마이너스로 갈수록 작성 가능한 최소 신뢰도가 올라간다.
// v4에서 무정보 EV는 c=1에서 0, c≥2부터 −B·p₀(1−p₀)·c(c−1)/2로 가속 음수 —
// 래더가 c≥2를 강제하는 순간 스팸의 하강이 구조적으로 보장된다.
// 최하단은 강제 탈퇴 대신 해당 자산군 신규 게시 정지(시즌 종료까지).

export interface Discipline {
  /** 작성 가능한 최소 신뢰도 (1이면 제약 없음) */
  minConfidence: number;
  /** 해당 자산군 신규 게시 정지 여부 */
  publishSuspended: boolean;
}

export const DISCIPLINE_LADDER: ReadonlyArray<{ scoreBelow: number } & Discipline> = [
  { scoreBelow: -10_000, minConfidence: 10, publishSuspended: true },
  { scoreBelow: -6_000, minConfidence: 7, publishSuspended: false },
  { scoreBelow: -3_000, minConfidence: 5, publishSuspended: false },
  { scoreBelow: -1_000, minConfidence: 2, publishSuspended: false },
];

/** 자산군별 누적 점수 → 현재 적용되는 규율 */
export function disciplineFor(assetClassScore: number): Discipline {
  for (const rung of DISCIPLINE_LADDER) {
    if (assetClassScore <= rung.scoreBelow) {
      return { minConfidence: rung.minConfidence, publishSuspended: rung.publishSuspended };
    }
  }
  return { minConfidence: CONFIDENCE_RANGE.min, publishSuspended: false };
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
    return { realizedReturnPct: null, score: 0, directionScore: 0, stabilityScore: 0 };
  }
  const realizedReturnPct = ((input.settledPrice - input.basePrice) / input.basePrice) * 100;
  const predictedMagnitudePct =
    input.targetType === 'RETURN_PCT'
      ? input.targetValue
      : targetPriceToMagnitudePct(input.targetValue, input.basePrice);
  const { score } = computeReachScore(
    input.direction,
    predictedMagnitudePct,
    input.confidence,
    input.assetClass,
    input.horizonDays,
    input.outcome === 'HIT',
    input.sigmaDaily,
  );
  return { realizedReturnPct, score, directionScore: score, stabilityScore: 0 };
}
