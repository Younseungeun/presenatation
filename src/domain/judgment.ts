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
  /** 게시~시한 기간 중 최고가 (목표가 도달 판정용) */
  highSincePublish?: number;
  /** 게시~시한 기간 중 최저가 */
  lowSincePublish?: number;
}

export interface JudgmentResult {
  outcome: Outcome;
  undecidableReason?: UndecidableReason;
  /** 판정에 사용된 가격 (판정 불가 시 undefined) */
  settledPrice?: number;
}

/**
 * 예측 카드 1건을 판정한다.
 * - 거래정지·상장폐지·철회·데이터 결측 → UNDECIDABLE (무효 처리 + 전액 환불 + 수수료 미발생)
 * - TARGET_PRICE: 기간 중 목표가 도달 여부 (상승: 고가 기준, 하락: 저가 기준)
 * - RETURN_PCT: 시한 종가 기준 등락률이 목표 크기 이상인지
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

  if (card.targetType === 'TARGET_PRICE') {
    if (card.direction === 'UP') {
      if (market.highSincePublish === undefined) {
        return { outcome: 'UNDECIDABLE', undecidableReason: 'AMBIGUOUS' };
      }
      return market.highSincePublish >= card.targetValue
        ? { outcome: 'HIT', settledPrice: market.highSincePublish }
        : { outcome: 'MISS', settledPrice: market.highSincePublish };
    }
    if (market.lowSincePublish === undefined) {
      return { outcome: 'UNDECIDABLE', undecidableReason: 'AMBIGUOUS' };
    }
    return market.lowSincePublish <= card.targetValue
      ? { outcome: 'HIT', settledPrice: market.lowSincePublish }
      : { outcome: 'MISS', settledPrice: market.lowSincePublish };
  }

  // RETURN_PCT
  if (market.priceAtDeadline === undefined || card.basePrice <= 0) {
    return { outcome: 'UNDECIDABLE', undecidableReason: 'AMBIGUOUS' };
  }
  const returnPct = ((market.priceAtDeadline - card.basePrice) / card.basePrice) * 100;
  const hit =
    card.direction === 'UP' ? returnPct >= card.targetValue : returnPct <= -card.targetValue;
  return { outcome: hit ? 'HIT' : 'MISS', settledPrice: market.priceAtDeadline };
}
