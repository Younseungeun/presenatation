// 도메인 상수·타입 단일 기준.
// SQLite가 enum을 지원하지 않아 DB에는 문자열로 저장하고, 코드에서는 이 모듈만 참조한다.

export const ASSET_CLASSES = ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** 화면 표시용 자산군 한글명 (단일 기준 — 페이지별 중복 정의 금지) */
export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  KR_EQUITY: '국내주식',
  US_EQUITY: '미국주식',
  CRYPTO: '코인',
};

export const USER_ROLES = ['USER', 'OPERATOR'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const TIERS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'CHALLENGER'] as const;
export type Tier = (typeof TIERS)[number];

// 등급 명칭 (2026-08-05 확정 — 브랜드 규정 brand/intovill/README.md §4-4 준용).
// 내부 키(BRONZE~CHALLENGER)는 DB·TierHistory에 저장돼 있어 그대로 두고 표시만 바꾼다.
/** 배지(등급 칩) 표시 명칭 — BRONZE는 무표기: 칩을 그리지 않는다 (신입 딱지 방지) */
export const TIER_LABEL: Record<Tier, string> = {
  BRONZE: '',
  SILVER: '시니어',
  GOLD: '마스터',
  PLATINUM: '펠로우',
  CHALLENGER: '인투빌 펠로우',
};
/** 문장 속 지칭용 이름 — 무표기 등급도 문장에서는 이름이 필요하다 */
export const TIER_NAME: Record<Tier, string> = { ...TIER_LABEL, BRONZE: '무표기' };

export const OUTCOMES = ['HIT', 'MISS', 'UNDECIDABLE'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const DIRECTIONS = ['UP', 'DOWN'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const TARGET_TYPES = ['TARGET_PRICE', 'RETURN_PCT'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const UNDECIDABLE_REASONS = ['TRADING_HALT', 'DELISTED', 'AMBIGUOUS', 'WITHDRAWN'] as const;
export type UndecidableReason = (typeof UNDECIDABLE_REASONS)[number];

// 기준가 확정 방식 (publishReport.ts의 컷오프 규칙과 연동):
// - FIXED_AT_PUBLISH: 게시 시 확정 (실시간가 또는 직전 종가) — 코인·장기 카드
// - PREV_CLOSE_AT_JUDGMENT: 직전 거래일 종가를 판정 시 소급 확정 — 개장 전 게시 단기 카드
// - DAY_CLOSE_AT_JUDGMENT: 게시일(이후 첫 거래일) 종가를 판정 시 소급 확정 — 장중·장후·주말 게시
//   단기 카드. 당일 실현 등락이 기준가에 흡수되므로 장중 게시여도 정보 이점이 없다
export const BASE_MODES = [
  'FIXED_AT_PUBLISH',
  'PREV_CLOSE_AT_JUDGMENT',
  'DAY_CLOSE_AT_JUDGMENT',
] as const;
export type BaseMode = (typeof BASE_MODES)[number];

export const PREPAYMENT_RATIOS = [0, 10, 20, 30] as const;
export type PrepaymentRatio = (typeof PREPAYMENT_RATIOS)[number];

// 표본 수 미만이면 프로필에 "검증 중" 배지 표시
export const MIN_SAMPLE_FOR_VERIFIED = 10;
