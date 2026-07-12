// 도메인 상수·타입 단일 기준.
// SQLite가 enum을 지원하지 않아 DB에는 문자열로 저장하고, 코드에서는 이 모듈만 참조한다.

export const ASSET_CLASSES = ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const TIERS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'CHALLENGER'] as const;
export type Tier = (typeof TIERS)[number];

export const OUTCOMES = ['HIT', 'MISS', 'UNDECIDABLE'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const DIRECTIONS = ['UP', 'DOWN'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const TARGET_TYPES = ['TARGET_PRICE', 'RETURN_PCT'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const UNDECIDABLE_REASONS = ['TRADING_HALT', 'DELISTED', 'AMBIGUOUS', 'WITHDRAWN'] as const;
export type UndecidableReason = (typeof UNDECIDABLE_REASONS)[number];

// 기준가 확정 방식: 게시 시 확정(실시간가 또는 직전 종가) / 판정 시 소급 확정(KR 개장 전 단기 카드)
export const BASE_MODES = ['FIXED_AT_PUBLISH', 'PREV_CLOSE_AT_JUDGMENT'] as const;
export type BaseMode = (typeof BASE_MODES)[number];

export const PREPAYMENT_RATIOS = [0, 10, 20, 30] as const;
export type PrepaymentRatio = (typeof PREPAYMENT_RATIOS)[number];

// 표본 수 미만이면 프로필에 "검증 중" 배지 표시
export const MIN_SAMPLE_FOR_VERIFIED = 10;
