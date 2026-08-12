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

export const CONFIDENCE_RANGE = { min: 1, max: 10 } as const;

/** 방향·크기 점수 스케일 — 크기 1%p당 기본 지분 (v3 스케일 계승) */
export const DIRECTION_SCALE = 10;

/**
 * 자산군별 예측 크기(%) 하한 — 초안, 운영 데이터로 조정 예정.
 * 게시 검증(publishReport)에서 쓴다.
 */
export const MIN_MAGNITUDE_PCT: Record<AssetClass, number> = {
  KR_EQUITY: 5,
  US_EQUITY: 5,
  CRYPTO: 10,
};

/**
 * 자산군별 일 변동성 σ̄ (거래일 기준) — p₀ 계산의 입력. 초안.
 *
 * ⚠ 자산군 공통 상수라 **종목별 변동성 차익**이 남는다: 실제 σ가 σ̄보다 큰 종목
 * (고변동 코인 등)은 실제 무정보 도달 확률이 모델 p₀보다 높아 스팸 EV가 양수로
 * 샐 수 있다. 후속: 게시 시점에 그 종목의 최근 60거래일 실현 변동성을 재서
 * 카드에 고정(clamp [0.5σ̄, 2σ̄]) — 우리 일봉 데이터(KIS)로 계산 가능하다.
 */
export const DAILY_SIGMA: Record<AssetClass, number> = {
  KR_EQUITY: 0.02,
  US_EQUITY: 0.02,
  CRYPTO: 0.04,
};

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
export function maxMagnitudePct(assetClass: AssetClass, horizonDays: number): number {
  const days = Math.max(1, horizonDays);
  return MONTHLY_MAGNITUDE_CAP_PCT[assetClass] * Math.sqrt(days / 30);
}

/** 적중 시 증폭 배율 */
export function winAmplifier(confidence: number): number {
  return confidence;
}

/** 실패 시 증폭 배율 — 신뢰도에 초선형 (proper scoring: 정직한 승산 신고가 최적) */
export function lossAmplifier(confidence: number): number {
  return (confidence * (confidence + 1)) / 2;
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
  /** 종목별 실현 변동성으로 덮을 때 (후속 — 지금은 자산군 σ̄) */
  sigmaDaily = DAILY_SIGMA[assetClass],
): number {
  if (magnitudePct <= 0) throw new Error(`예측 크기는 양수여야 합니다: ${magnitudePct}`);
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

/**
 * 정직한 신뢰도 — 자기 승산이 무정보의 몇 배인지.
 * c → c+1 이득 조건 odds(p) ≥ (c+1)·odds(p₀)에서 바로 나온다:
 *   c* = clamp(⌊odds(p)/odds(p₀)⌋, 1, 10)
 * 화면(점수 계산기)이 "이 확신이면 신뢰도 몇이 정직한가"를 보여줄 때 쓴다.
 */
export function honestConfidence(pTrue: number, p0: number): number {
  const odds = (x: number) => x / Math.max(1e-9, 1 - x);
  const multiple = odds(pTrue) / Math.max(1e-9, odds(p0));
  return Math.min(CONFIDENCE_RANGE.max, Math.max(CONFIDENCE_RANGE.min, Math.floor(multiple)));
}

export interface ReachScore {
  /** 무정보 도달 확률 — 게시 사양(방향·크기·기간·자산군)만의 함수 */
  p0: number;
  /** 적중 시 +B·c·(1−p₀) / 실패 시 −B·c(c+1)/2·p₀ */
  score: number;
}

/** v4 본체 — 공정배당 이항 점수 */
export function computeReachScore(
  direction: Direction,
  magnitudePct: number,
  confidence: number,
  assetClass: AssetClass,
  horizonDays: number,
  hit: boolean,
): ReachScore {
  assertConfidence(confidence);
  const p0 = noSkillTouchProbability(direction, magnitudePct, assetClass, horizonDays);
  const stake = DIRECTION_SCALE * magnitudePct;
  const score = hit
    ? stake * winAmplifier(confidence) * (1 - p0)
    : -stake * lossAmplifier(confidence) * p0;
  return { p0, score };
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
  /** @deprecated v4에서 점수 기여 없음 — 경로 안정성 배팅 재설계 전까지 무시된다 */
  stability: number;
  /** 자산군 — 무정보 변동성 σ̄ 결정 */
  assetClass: AssetClass;
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
  );
  return { realizedReturnPct, score, directionScore: score, stabilityScore: 0 };
}
