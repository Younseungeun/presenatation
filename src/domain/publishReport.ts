import type {
  AssetClass,
  BaseMode,
  Direction,
  PrepaymentRatio,
  TargetType,
  Tier,
} from './constants';
import { calcFeeRateBp } from './fees';
import { marketClock } from './marketData';
import { disciplineFor, MIN_MAGNITUDE_PCT, targetPriceToMagnitudePct } from './scoring';

// 리포트 게시 검증 규칙 (순수 로직).
// 게시는 되돌릴 수 없는 행위다: 수수료·선결제 비율·기준가가 고정되고 예측 카드가 잠긴다.
// 여기서 걸러지지 않으면 판정·정산까지 오염되므로 검증은 게시 시점에 전부 끝낸다.

/** 플랫폼 가격 가이드 (CLAUDE.md 3.4절: 건당 5천~5만원) */
export const PRICE_GUIDE_KRW = { min: 5_000, max: 50_000 } as const;

/**
 * 리서처당 자산군별 동시 활성(게시·미판정·미철회) 카드 상한 — 초안 수치.
 * 목적: 신뢰도 1 저품질 대량 게시의 마지막 구멍 차단 (docs/score-discipline-sim.md).
 * 마이너스 규율은 기대 점수 ≈ 0인 신뢰도 1 스팸에 발동하지 않는데, 그 동기는
 * 점수가 아니라 판매 수익이므로 노출 총량 자체를 제한한다.
 * 검증 전 신규(브론즈)는 소수의 카드에 집중하게 좁게 열고,
 * 검증된 상위 등급일수록 슬롯이 늘어난다.
 * 판정·철회로 카드가 닫히면 슬롯이 즉시 회수된다.
 */
export const MAX_ACTIVE_CARDS: Record<Tier, number> = {
  BRONZE: 5,
  SILVER: 7,
  GOLD: 10,
  PLATINUM: 12,
  CHALLENGER: 15,
};

/**
 * 검증 시한 최소(자산군별, 초안 단계)·최대.
 * 최소 시한은 기술 제약이 아니라 조작 방지 장치다: EOD 기준가로 초단기 예측을 허용하면
 * 게시 시점에 이미 실현된 등락을 공짜로 가져갈 수 있다. 자산군별 해법:
 * - CRYPTO 1일: 게시 순간 실시간 현재가(업비트 ticker)가 기준가
 * - KR/US EQUITY 0일(당일 종가)~: 게시 시각별 컷오프 규칙을 따른다 (planBaseMode)
 */
export const DEADLINE_MIN_DAYS: Record<AssetClass, number> = {
  KR_EQUITY: 0,
  US_EQUITY: 0,
  CRYPTO: 1,
};
export const DEADLINE_MAX_DAYS = 365;

/** 이 시한(일) 미만의 주식 카드는 컷오프 규칙(planBaseMode)을 따른다 */
export const EQUITY_SHORT_HORIZON_DAYS = 7;

/** 장 시작 후·주말 게시 단기 카드의 최소 시한: 게시일로부터 N일 (시장 시간대 날짜 기준) */
export const AFTER_CUTOFF_MIN_DEADLINE_DAYS = 2;

/**
 * "당일 체결 정보가 아직 없다"고 볼 수 있는 개장 전 컷오프 — 국내주식만 존재한다.
 * - KR 08:00 KST: 대체거래소 NXT 프리마켓(08:00~)과 KRX 장전 시간외(08:00~)가 시작되어
 *   가격 발견이 일어나는 시점. 그 전(전일 20:00 NXT 마감 ~ 당일 08:00)은 거래 공백이라
 *   직전 종가 기준의 당일 예측이 깨끗하다
 * - US: 이런 창구가 없다. 애프터마켓(전일 16~20시 ET) → 주간거래·오버나이트 ATS
 *   (20~04시 ET, 국내 증권사 '주간거래' = 한국 낮 시간) → 프리마켓(04~09:30 ET)이
 *   사실상 연속이라 정보 공백 시점이 존재하지 않는다 → 당일 카드 불가,
 *   단기 카드는 항상 게시일+2일(기준가 = 게시 이후 첫 정규장 종가)
 */
export const KR_PUBLISH_CUTOFF = {
  timeZone: 'Asia/Seoul',
  cutoff: '08:00',
  label: 'NXT 프리마켓·장전 시간외 시작 전(08:00 KST)',
} as const;

/** 정규장 마감 시각 — 이후 게시는 그날 종가가 이미 공개된 뒤라 기준일을 다음 거래일로 굴린다 */
export const EQUITY_REGULAR_CLOSE: Record<Exclude<AssetClass, 'CRYPTO'>, string> = {
  KR_EQUITY: '15:30',
  US_EQUITY: '16:00',
};

const TICKER_PATTERNS: Record<AssetClass, RegExp> = {
  KR_EQUITY: /^\d{6}$/, // 6자리 단축코드
  US_EQUITY: /^[A-Z][A-Z.]{0,9}$/, // 심볼 (BRK.B 등 클래스 표기 허용)
  CRYPTO: /^KRW-[A-Z0-9]{2,10}$/, // 업비트 KRW 마켓코드
};

export interface CardDraft {
  assetClass: AssetClass;
  ticker: string;
  assetName: string;
  /** 방향: UP = buy, DOWN = sell */
  direction: Direction;
  targetType: TargetType;
  /** 크기: 목표가 또는 목표 등락률(%) */
  targetValue: number;
  /** 기간(검증 시한) */
  deadline: Date;
  /** 신뢰도 1~10 (필수) — 점수 증폭 배율 */
  confidence: number;
  /** 자기 평가 안정성 1~10 (필수, 표시용) */
  selfStability: number;
  /** 자기 평가 수익성 1~10 (필수, 표시용) */
  selfProfitability: number;
}

export interface PublishConditions {
  priceKrw: number;
  prepaymentRatio: PrepaymentRatio;
  tier: Tier;
  promoActive: boolean;
  /**
   * 해당 자산군의 리서처 누적 점수 — 마이너스 규율(최소 신뢰도 상승·게시 정지) 판단용.
   * 점수 집계 배치가 붙기 전까지는 0 (규율 미발동).
   */
  assetClassScore?: number;
  /** 해당 자산군의 현재 활성(게시·미판정·미철회) 카드 수 — 동시 게시 상한 판단용 */
  activeCardCount?: number;
}

export class PublishValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' / '));
    this.name = 'PublishValidationError';
  }
}

/** 'YYYY-MM-DD' 두 날짜의 차이(일) */
function dateDiffDays(a: string, b: string): number {
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export interface BaseModePlan {
  baseMode: BaseMode;
  issues: string[];
}

/**
 * 게시 시각과 시한으로 기준가 확정 방식을 결정한다 (조작 방지 규칙의 심장부).
 *
 * 주식 단기 카드(시한 7일 미만):
 * - KR, 평일 08:00 KST 전(당일 체결 정보가 아직 없음): 당일 종가 예측부터 허용.
 *   기준가 = 직전 거래일 종가, 판정 시 소급 확정 (데이터 D+1 지연 때문)
 * - KR 그 외 시각·주말, US 상시: 시한은 게시일로부터 2일 이상.
 *   기준가 = 게시 이후 첫 정규장 종가 소급 확정 — 게시 시점까지 실현된 등락이
 *   전부 기준가에 흡수되므로 게시 시각과 무관하게 정보 이점이 없다.
 *   (US는 애프터마켓·주간거래·프리마켓이 연속이라 '개장 전' 창구 자체가 없음)
 * 그 외(코인·장기 카드): 게시 시점 확정 (실시간가 또는 직전 종가)
 *
 * 공휴일 게시는 달력 없이 걸러낼 수 없다 — 그날 시세가 없으면 판정이 이월 후
 * 수동 보류 큐로 가므로 오판정으로 이어지지 않는다.
 */
export function planBaseMode(
  assetClass: AssetClass,
  deadline: Date,
  now: Date,
): BaseModePlan {
  const horizonDays = (deadline.getTime() - now.getTime()) / 86_400_000;
  if (assetClass === 'CRYPTO' || horizonDays >= EQUITY_SHORT_HORIZON_DAYS) {
    return { baseMode: 'FIXED_AT_PUBLISH', issues: [] };
  }

  const timeZone = assetClass === 'KR_EQUITY' ? KR_PUBLISH_CUTOFF.timeZone : 'America/New_York';
  const clock = marketClock(now, timeZone);

  if (assetClass === 'KR_EQUITY') {
    const weekend = clock.weekday === 'Sat' || clock.weekday === 'Sun';
    if (!weekend && clock.time < KR_PUBLISH_CUTOFF.cutoff) {
      return { baseMode: 'PREV_CLOSE_AT_JUDGMENT', issues: [] };
    }
  }

  // 기준가 = 게시 이후 첫 종가이므로, 시한은 그 이후 거래일이어야 의미가 있다
  const deadlineDate = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(deadline);
  const diff = dateDiffDays(deadlineDate, clock.date);
  const guide =
    assetClass === 'KR_EQUITY'
      ? `당일·익일 예측은 ${KR_PUBLISH_CUTOFF.label}에만 게시할 수 있습니다`
      : '미국주식은 애프터마켓·주간거래·프리마켓이 연속이라 당일·익일 예측 창구가 없습니다';
  const issues =
    diff < AFTER_CUTOFF_MIN_DEADLINE_DAYS
      ? [
          `${assetClass} 단기 예측: 시한이 게시일로부터 ${AFTER_CUTOFF_MIN_DEADLINE_DAYS}일 이상이어야 합니다 (요청: ${diff}일). ${guide}`,
        ]
      : [];
  return { baseMode: 'DAY_CLOSE_AT_JUDGMENT', issues };
}

export function validateCardDraft(card: CardDraft, now = new Date()): string[] {
  const issues: string[] = [];

  if (!TICKER_PATTERNS[card.assetClass].test(card.ticker)) {
    issues.push(`${card.assetClass} 티커 형식이 아닙니다: ${card.ticker}`);
  }
  if (card.assetName.trim().length === 0) {
    issues.push('자산명이 비어 있습니다');
  }
  // 종목 유니버스·하락 예측 가능 여부는 종목 마스터(DB) 기준 — 서비스 레이어에서 검증
  // (instrumentService.validateListedInstrument)
  if (!Number.isFinite(card.targetValue) || card.targetValue <= 0) {
    issues.push(`목표 수치는 양수여야 합니다 (RETURN_PCT는 등락률 크기): ${card.targetValue}`);
  }
  // 초소형 크기 예측 방지: 수익률형은 초안 단계에서 즉시 검증 (목표가형은 기준가 확정 시)
  if (card.targetType === 'RETURN_PCT' && card.targetValue < MIN_MAGNITUDE_PCT[card.assetClass]) {
    issues.push(
      `${card.assetClass} 예측 크기는 최소 ${MIN_MAGNITUDE_PCT[card.assetClass]}% 이상이어야 합니다: ${card.targetValue}% — 작은 크기는 사실상 방향 맞히기로 만점이 되기 때문입니다`,
    );
  }
  for (const [label, value] of [
    ['신뢰도', card.confidence],
    ['안정성', card.selfStability],
    ['수익성', card.selfProfitability],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      issues.push(`${label}(자기 평가)은 1~10 정수여야 합니다: ${value}`);
    }
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
  /** 기준가 확정 방식 — KR 단기 카드는 판정 시 소급 확정 */
  baseMode: BaseMode;
  /** FIXED_AT_PUBLISH면 확정값, AT_JUDGMENT면 null (판정 배치가 기록) */
  basePrice: number | null;
  publishedAt: Date;
}

/**
 * 게시 스냅샷을 확정한다.
 * - 일반 카드: basePrice는 호출자가 시세 공급자에서 실측(실시간가 또는 직전 종가)해 넘긴다
 * - KR 단기 카드(시한 7일 미만): 개장 전 컷오프 검증 후 기준가를 판정 시 소급 확정으로 둔다
 * 검증 실패 시 PublishValidationError — 부분 게시는 없다.
 */
export function preparePublish(
  card: CardDraft,
  cond: PublishConditions,
  basePrice: number | null,
  now = new Date(),
): PublishSnapshot {
  const issues = [...validateCardDraft(card, now), ...validateConditions(cond)];
  const plan = planBaseMode(card.assetClass, card.deadline, now);
  const retroactive = plan.baseMode !== 'FIXED_AT_PUBLISH';

  // 동시 활성 카드 상한: 신뢰도 1 저품질 대량 게시 차단 (자산군별, 등급별 슬롯)
  const maxActive = MAX_ACTIVE_CARDS[cond.tier];
  if ((cond.activeCardCount ?? 0) >= maxActive) {
    issues.push(
      `${card.assetClass} 동시 활성 카드가 상한(${cond.tier} ${maxActive}건)에 도달했습니다 — 기존 카드가 판정되거나 철회되면 다시 게시할 수 있습니다`,
    );
  }

  // 마이너스 점수 규율: 게시 정지 또는 최소 신뢰도 상승 (자산군별)
  const discipline = disciplineFor(cond.assetClassScore ?? 0);
  if (discipline.publishSuspended) {
    issues.push(
      `${card.assetClass} 누적 점수 미달로 신규 게시가 정지되었습니다 (시즌 종료까지). 진행 중인 카드는 정상 판정·정산됩니다`,
    );
  } else if (card.confidence < discipline.minConfidence) {
    issues.push(
      `현재 ${card.assetClass} 누적 점수에서는 신뢰도 ${discipline.minConfidence} 이상만 게시할 수 있습니다 (입력: ${card.confidence}) — 낮은 신뢰도로 시행 횟수를 늘리는 것을 막기 위한 규율입니다`,
    );
  }

  if (retroactive) {
    issues.push(...plan.issues);
    // 소급 확정 카드는 게시 시점에 기준가가 없어 목표가의 방향 정합성·크기 하한을
    // 검증할 수 없다 → 수익률형만 허용 (크기 하한은 초안 검증에서 이미 처리됨)
    if (card.targetType === 'TARGET_PRICE') {
      issues.push(
        '기준가를 판정 시 소급 확정하는 단기 카드는 수익률형(RETURN_PCT)만 허용됩니다',
      );
    }
  } else {
    if (basePrice === null || !Number.isFinite(basePrice) || basePrice <= 0) {
      issues.push(`기준가를 확정할 수 없습니다 (시세 조회 결과: ${basePrice})`);
    }
    // 목표가형은 방향·크기의 정합성 검증 (상승 예측인데 목표가가 기준가 이하 등)
    if (card.targetType === 'TARGET_PRICE' && basePrice !== null && basePrice > 0) {
      if (card.direction === 'UP' && card.targetValue <= basePrice) {
        issues.push(`상승 예측의 목표가(${card.targetValue})가 기준가(${basePrice}) 이하입니다`);
      }
      if (card.direction === 'DOWN' && card.targetValue >= basePrice) {
        issues.push(`하락 예측의 목표가(${card.targetValue})가 기준가(${basePrice}) 이상입니다`);
      }
      const magnitude = targetPriceToMagnitudePct(card.targetValue, basePrice);
      if (magnitude < MIN_MAGNITUDE_PCT[card.assetClass]) {
        issues.push(
          `${card.assetClass} 예측 크기는 최소 ${MIN_MAGNITUDE_PCT[card.assetClass]}% 이상이어야 합니다 (목표가 기준 ${magnitude.toFixed(1)}%)`,
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new PublishValidationError(issues);
  }

  return {
    feeRateBp: calcFeeRateBp(cond),
    baseMode: plan.baseMode,
    basePrice: retroactive ? null : basePrice,
    publishedAt: now,
  };
}
