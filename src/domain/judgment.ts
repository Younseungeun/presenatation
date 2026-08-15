import type { Direction, Outcome, TargetType, UndecidableReason } from './constants';

// 시장 데이터 자동 판정 엔진.
// 데이터 소스(시세 API)는 미확정이므로 이 모듈은 스냅샷 입력 → 판정 결과의 순수 함수로 유지하고,
// API 어댑터는 별도 레이어에서 붙인다.

export interface PredictionInput {
  direction: Direction;
  targetType: TargetType;
  /** TARGET_PRICE: 목표가(원) / RETURN_PCT: 목표 등락률의 크기(%, 양수) */
  targetValue: number;
  /** 게시 시점 기준가 */
  basePrice: number;
  /** 철회된 카드는 판정 불가 처리 (기록은 유지) */
  withdrawn?: boolean;
}

export interface MarketSnapshot {
  /** 검증 시한 시점의 종목 상태 */
  status: 'TRADED' | 'TRADING_HALT' | 'DELISTED';
  /** 검증 시한 종가 */
  priceAtDeadline?: number;
  /**
   * 게시~시한 기간 중 **일봉 종가의 최고값** (상승 카드 도달 판정용).
   * 장중 고가가 아니다 — 도달은 종가로만 인정한다. 순간 꼬리(wick) 하나로 적중이
   * 만들어지면 시세를 튀겨 판정을 조작하는 통로가 열린다 (판매 마감과 같은 원칙)
   */
  maxCloseSincePublish?: number;
  /** 게시~시한 기간 중 일봉 종가의 최저값 (하락 카드 도달 판정용) */
  minCloseSincePublish?: number;
}

export interface JudgmentResult {
  outcome: Outcome;
  undecidableReason?: UndecidableReason;
  /** 판정에 사용된 가격 (판정 불가 시 undefined) */
  settledPrice?: number;
  /**
   * 목표까지 **가장 가까이 갔던 지점** — 기준가 0, 목표가 1 (MISS에만 실린다).
   *
   * 판정에는 쓰이지 않는다. 점수도 적중률도 규율 래더도 이 값을 보지 않는다 —
   * 주장은 이항이고 "얼마나 아깝게 틀렸나"는 여전히 틀린 것이다.
   *
   * **오직 리서처에게 알려 주기 위해 잰다.** 실패 알림이 "점수 −N점, 정산 0원"뿐이면
   * +9.8%로 끝난 사람과 −30%로 끝난 사람이 똑같은 문장을 받는다. 시스템이 이미
   * 알고 있는 사실(종가 극값)을 안 알려 주는 것이고, 그 침묵이 "이 플랫폼은 내
   * 분석을 보지 않는다"로 읽힌다.
   *
   * 구매자 상황 막대(domain/cardProgress)와 **같은 눈금**이다 — 판정 후에 다른
   * 자를 들이대면 사던 날 보던 막대와 결과가 어긋난다.
   */
  peakProgress?: number;
}

/**
 * 예측 카드 1건을 판정한다.
 *
 * ── 판정 규칙은 **하나뿐이다** (2026-08-10 통합) ─────────────────
 *   **"검증 시한 안에 목표가에 닿은 일봉 종가가 있는가."**  있으면 적중, 없으면 실패.
 *
 * **종가만 본다 — 장중 터치는 도달이 아니다.** 장중에 목표를 스쳐도 그날 종가가
 * 돌아왔으면 도달로 치지 않는다. 순간 꼬리(wick) 하나로 적중이 만들어지면 시세를
 * 튀겨 판정을 조작하는 통로가 열린다 — 판매 마감이 종가만 보는 것과 같은 원칙이다.
 * 장중 시세의 몫은 판정이 아니라 **결제 관문의 판매 중단**(즉시·가역)이다.
 *
 * 예전에는 입력 형식에 따라 규칙이 갈렸다 — 목표가로 쓰면 장중 터치 기준, 수익률로
 * 쓰면 시한 종가 기준. 그런데 기준가 100에서 "120까지 간다"와 "20% 오른다"는
 * **같은 주장**이다. 같은 주장을 입력 칸으로 다르게 판정하는 것은 근거가 없었다.
 * targetType은 이제 **입력 형식의 기록**일 뿐이고, 판정에서는 목표가로 환산해 쓴다.
 *
 * 시한은 정산일이 아니라 **마감선**이다: "30일 안에 20% 오른다"는 예측은 3일째
 * 종가가 20%를 넘으면 그 시점에 이뤄진 것이지, 30일째를 기다려야 할 이유가 없다.
 *
 * ── 판정가(settledPrice) = **주장이 참이면 주장한 값, 거짓이면 실제 값** ──────
 *   적중 → **목표가**. 초과분은 넣지 않는다. 리서처가 주장한 것은 "여기까지 간다"이지
 *          "정확히 여기에 멈춘다"가 아니라, 시장이 더 갔다고 벌점을 줄 근거가 없다.
 *          덤으로 도달 시점에 판정하든 시한까지 기다리든 **점수가 같아진다**.
 *   실패 → **시한 종가**. 구간 극값(가장 가까이 갔던 지점)을 쓰면 안 된다:
 *          +10%를 예측하고 잠깐 +1%를 찍었다가 −10%로 끝난 카드가 **플러스 점수**를
 *          받는다(실측으로 확인했다). 스치듯 지나간 고점은 예측력의 증거가 아니라
 *          잡음이고, 실패한 예측의 실제 결과는 결국 어디에 있었느냐다.
 *
 * 판정과 점수가 다른 것을 보는 것은 서로 다른 질문에 답하기 때문이다:
 *   판정 = "예측이 이뤄졌는가" → 기한 안에 닿았는가
 *   점수 = "시장을 얼마나 맞혔는가" → 실현된 결과가 무엇인가
 *
 * 그 외: 거래정지·상장폐지·철회·데이터 결측 → UNDECIDABLE (무효 + 전액 환불 + 수수료 0)
 */
export function judge(card: PredictionInput, market: MarketSnapshot): JudgmentResult {
  if (card.withdrawn) {
    return { outcome: 'UNDECIDABLE', undecidableReason: 'WITHDRAWN' };
  }
  if (market.status === 'TRADING_HALT') {
    return { outcome: 'UNDECIDABLE', undecidableReason: 'TRADING_HALT' };
  }
  if (market.status === 'DELISTED') {
    return { outcome: 'UNDECIDABLE', undecidableReason: 'DELISTED' };
  }

  const targetPrice = resolveTargetPrice(card);
  if (targetPrice === null) {
    return { outcome: 'UNDECIDABLE', undecidableReason: 'AMBIGUOUS' };
  }

  // 방향 분기는 "어느 쪽 종가 극값을 보는가"뿐이다 — 상승은 최고 종가, 하락은 최저 종가
  const up = card.direction === 'UP';
  const extreme = up ? market.maxCloseSincePublish : market.minCloseSincePublish;
  if (extreme === undefined) {
    return { outcome: 'UNDECIDABLE', undecidableReason: 'AMBIGUOUS' };
  }

  if (up ? extreme >= targetPrice : extreme <= targetPrice) {
    return { outcome: 'HIT', settledPrice: targetPrice };
  }
  // 실패는 시한 종가로 잰다 — 종가가 없으면 실현값을 알 수 없어 판정하지 않는다
  if (market.priceAtDeadline === undefined) {
    return { outcome: 'UNDECIDABLE', undecidableReason: 'AMBIGUOUS' };
  }
  // 목표까지 얼마나 갔었나 — **판정에는 쓰지 않고 리서처에게만 알린다** (peakProgress).
  // 분모는 기준가→목표가의 폭이라 방향 부호가 저절로 상쇄된다(하락 카드도 그대로 맞다).
  const span = targetPrice - card.basePrice;
  return {
    outcome: 'MISS',
    settledPrice: market.priceAtDeadline,
    ...(span !== 0 && card.basePrice > 0
      ? { peakProgress: (extreme - card.basePrice) / span }
      : {}),
  };
}

/**
 * 목표가로 환산한다 — 수익률형도 결국 "이 가격에 닿는가"로 판정된다.
 * 기준가가 없거나 0 이하면(소급 확정 대기 중 결측) 환산이 불가능해 판정하지 않는다.
 */
function resolveTargetPrice(card: PredictionInput): number | null {
  if (card.targetType === 'TARGET_PRICE') {
    return card.targetValue > 0 ? card.targetValue : null;
  }
  if (card.basePrice <= 0) return null;
  const signed = card.direction === 'UP' ? card.targetValue : -card.targetValue;
  return card.basePrice * (1 + signed / 100);
}
