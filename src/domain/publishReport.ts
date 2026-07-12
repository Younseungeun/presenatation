import type { AssetClass, Direction, PrepaymentRatio, TargetType, Tier } from './constants';
import { calcFeeRateBp } from './fees';

// 리포트 게시 검증 규칙 (순수 로직).
// 게시는 되돌릴 수 없는 행위다: 수수료·선결제 비율·기준가가 고정되고 예측 카드가 잠긴다.
// 여기서 걸러지지 않으면 판정·정산까지 오염되므로 검증은 게시 시점에 전부 끝낸다.

/** 플랫폼 가격 가이드 (CLAUDE.md 3.4절: 건당 5천~5만원) */
export const PRICE_GUIDE_KRW = { min: 5_000, max: 50_000 } as const;

/**
 * 검증 시한 최소(자산군별)·최대.
 * 주식의 최소 7일은 기술 제약이 아니라 조작 방지 장치다: 기준가가 "직전 거래일 종가"(EOD)라서
 * 초단기 예측은 게시 시점에 이미 실현된 당일 등락을 공짜로 가져갈 수 있다.
 * 코인은 게시 시점 실시간 현재가(업비트 ticker)를 기준가로 쓰므로 1일 단타 예측을 허용한다.
 * 주식도 실시간 기준가 소스(KIS/Alpaca) 도입 시 단축한다 (docs/market-data.md §7).
 */
export const DEADLINE_MIN_DAYS: Record<AssetClass, number> = {
  KR_EQUITY: 7,
  US_EQUITY: 7,
  CRYPTO: 1,
};
export const DEADLINE_MAX_DAYS = 365;

const TICKER_PATTERNS: Record<AssetClass, RegExp> = {
  KR_EQUITY: /^\d{6}$/, // 6자리 단축코드
  US_EQUITY: /^[A-Z][A-Z.]{0,9}$/, // 심볼 (BRK.B 등 클래스 표기 허용)
  CRYPTO: /^KRW-[A-Z0-9]{2,10}$/, // 업비트 KRW 마켓코드
};

export interface CardDraft {
  assetClass: AssetClass;
  ticker: string;
  assetName: string;
  direction: Direction;
  targetType: TargetType;
  targetValue: number;
  deadline: Date;
  confidence?: number;
}

export interface PublishConditions {
  priceKrw: number;
  prepaymentRatio: PrepaymentRatio;
  tier: Tier;
  promoActive: boolean;
}

export class PublishValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' / '));
    this.name = 'PublishValidationError';
  }
}

export function validateCardDraft(card: CardDraft, now = new Date()): string[] {
  const issues: string[] = [];

  if (!TICKER_PATTERNS[card.assetClass].test(card.ticker)) {
    issues.push(`${card.assetClass} 티커 형식이 아닙니다: ${card.ticker}`);
  }
  if (card.assetName.trim().length === 0) {
    issues.push('자산명이 비어 있습니다');
  }
  if (!Number.isFinite(card.targetValue) || card.targetValue <= 0) {
    issues.push(`목표 수치는 양수여야 합니다 (RETURN_PCT는 등락률 크기): ${card.targetValue}`);
  }
  if (card.confidence !== undefined && (card.confidence < 1 || card.confidence > 5)) {
    issues.push(`확신도는 1~5 범위여야 합니다: ${card.confidence}`);
  }

  const daysToDeadline = (card.deadline.getTime() - now.getTime()) / 86_400_000;
  const minDays = DEADLINE_MIN_DAYS[card.assetClass];
  if (daysToDeadline < minDays) {
    issues.push(`${card.assetClass} 검증 시한은 최소 ${minDays}일 이후여야 합니다`);
  }
  if (daysToDeadline > DEADLINE_MAX_DAYS) {
    issues.push(`검증 시한은 최대 ${DEADLINE_MAX_DAYS}일 이내여야 합니다`);
  }

  return issues;
}

export function validateConditions(cond: PublishConditions): string[] {
  const issues: string[] = [];
  if (
    !Number.isInteger(cond.priceKrw) ||
    cond.priceKrw < PRICE_GUIDE_KRW.min ||
    cond.priceKrw > PRICE_GUIDE_KRW.max
  ) {
    issues.push(
      `가격은 ${PRICE_GUIDE_KRW.min.toLocaleString()}~${PRICE_GUIDE_KRW.max.toLocaleString()}원 범위의 정수여야 합니다: ${cond.priceKrw}`,
    );
  }
  try {
    calcFeeRateBp(cond); // 등급별 선결제 상한 검증 포함
  } catch (e) {
    issues.push((e as Error).message);
  }
  return issues;
}

export interface PublishSnapshot {
  /** 게시 시점 확정 총 수수료 (bp) — 판매 중 변경 불가 */
  feeRateBp: number;
  /** 목표가와 같은 통화의 게시 시점 기준가 — 직전 거래일 종가 */
  basePrice: number;
  publishedAt: Date;
}

/**
 * 게시 스냅샷을 확정한다. basePrice는 호출자가 시세 공급자에서 실측한
 * "게시 시점 직전 거래일 종가"를 넘긴다 (docs/market-data.md §6).
 * 검증 실패 시 PublishValidationError — 부분 게시는 없다.
 */
export function preparePublish(
  card: CardDraft,
  cond: PublishConditions,
  basePrice: number,
  now = new Date(),
): PublishSnapshot {
  const issues = [...validateCardDraft(card, now), ...validateConditions(cond)];

  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    issues.push(`기준가를 확정할 수 없습니다 (시세 조회 결과: ${basePrice})`);
  }
  // 목표가형은 방향과 목표가의 정합성 검증 (상승 예측인데 목표가가 기준가 이하 등)
  if (card.targetType === 'TARGET_PRICE' && Number.isFinite(basePrice) && basePrice > 0) {
    if (card.direction === 'UP' && card.targetValue <= basePrice) {
      issues.push(`상승 예측의 목표가(${card.targetValue})가 기준가(${basePrice}) 이하입니다`);
    }
    if (card.direction === 'DOWN' && card.targetValue >= basePrice) {
      issues.push(`하락 예측의 목표가(${card.targetValue})가 기준가(${basePrice}) 이상입니다`);
    }
  }

  if (issues.length > 0) {
    throw new PublishValidationError(issues);
  }

  return {
    feeRateBp: calcFeeRateBp(cond),
    basePrice,
    publishedAt: now,
  };
}
