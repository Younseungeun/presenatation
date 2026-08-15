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

// DATA_UNAVAILABLE = 시세를 끝내 구하지 못해 시한 + JUDGMENT_HARD_CAP_DAYS에 시스템이
// 닫은 경우. **플랫폼 사정이므로 전액 환불**이고, 리서처 점수에도 반영되지 않는다
// (판정 불가 공통 규칙 §2.5) — 소스 장애의 대가를 리서처가 지면 안 된다
export const UNDECIDABLE_REASONS = [
  'TRADING_HALT',
  'DELISTED',
  'AMBIGUOUS',
  'WITHDRAWN',
  'DATA_UNAVAILABLE',
] as const;
export type UndecidableReason = (typeof UNDECIDABLE_REASONS)[number];

// 기준가 확정 방식 (publishReport.ts의 컷오프 규칙과 연동):
// - FIXED_AT_PUBLISH: 게시 시 확정 (실시간가 또는 직전 종가) — 코인·장기 카드
// - PREV_CLOSE_AT_PUBLISH: 직전 거래일 종가를 **게시 시점에** 확정 — 개장 전 게시 단기 카드
// - PREV_CLOSE_AT_JUDGMENT: 같은 값을 판정 시 소급 확정하던 **옛 방식 (신규 게시에는 안 쓴다)**
//   근거가 데이터 지연이었다: 국내 시세가 금융위(D+1)였을 때는 아침에 직전 거래일 종가를
//   읽을 수 없었다. 2026-08-10에 KIS(실시간)로 갈아타면서 그 전제가 사라졌는데
//   방식만 남아 있었다 — 실측으로 확인했다(KST 02:52에 직전 거래일 종가가 그대로 온다).
//   미루면 대가가 있었다: 게시 관문이 기준가를 몰라 **크기 하한·방향 정합성을 검증하지
//   못하고**(그래서 목표가형을 금지해야 했고), 판정 시 그 종가를 못 찾으면 이월됐다.
//   **기존 카드는 이 값을 그대로 유지한다** — 판정 파이프라인의 소급 확정 경로도 남는다
// - DAY_CLOSE_AT_JUDGMENT: 게시일(이후 첫 거래일) 종가를 판정 시 소급 확정 — 장중·장후·주말 게시
//   단기 카드. 당일 실현 등락이 기준가에 흡수되므로 장중 게시여도 정보 이점이 없다
export const BASE_MODES = [
  'FIXED_AT_PUBLISH',
  'PREV_CLOSE_AT_PUBLISH',
  'PREV_CLOSE_AT_JUDGMENT',
  'DAY_CLOSE_AT_JUDGMENT',
] as const;
export type BaseMode = (typeof BASE_MODES)[number];

export const PREPAYMENT_RATIOS = [0, 10, 20, 30] as const;
export type PrepaymentRatio = (typeof PREPAYMENT_RATIOS)[number];

// 표본 수 미만이면 프로필에 "검증 중" 배지 표시
export const MIN_SAMPLE_FOR_VERIFIED = 10;

/**
 * **적중률 숫자 자체를 화면에 내보내기 시작하는 표본** (2026-08-15).
 *
 * 위의 `MIN_SAMPLE_FOR_VERIFIED`와 묻는 것이 다르다:
 *   · VERIFIED(10) — "이 숫자를 **믿을 만한가**" → 검증 중 배지, 순위 부여
 *   · RATE(5)      — "이 숫자를 **보여줘도 되는가**" → 아래면 숫자 대신 진행도
 *
 * 나눈 이유는 어뷰징이다. 계정 둘로 같은 종목에 상승·하락을 걸면 하나는 반드시
 * 적중하고, 실패한 쪽은 구매자가 전액 환불받아 항의하지 않으므로 버리는 값이 거의
 * 없다. 노리는 것은 **"적중률 100%" 스크린샷 한 장**이고, 그건 표본을 병기해도
 * (우리의 오랜 원칙) 캡처 한 장에는 남지 않는다.
 *
 * 5인 근거: 한 계정에 5연승을 몰아넣으려면 쌍을 32벌 굴려야 한다(0.5^5). 각 계정이
 * 실명 인증을 통과해야 하므로 그 비용이 실익을 넘는다. 10으로 올리면 1,024벌이라
 * 더 안전하지만, 정상 신규 리서처가 자기 실적을 못 보여주는 기간이 30일 카드 기준
 * 거의 1년이 된다 — **콜드스타트가 이 서비스의 1번 리스크**라 그 값은 너무 비싸다.
 *
 * 아래일 때 숫자를 감추는 것이 신규 리서처에게도 낫다: "100% (1건)"은 아무도 안 믿는
 * 숫자지만 "검증 1/5건"은 **플랫폼이 엄격하다**는 사실을 대신 말해 준다.
 */
export const MIN_SAMPLE_FOR_RATE = 5;
