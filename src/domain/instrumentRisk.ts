import type { AssetClass } from './constants';

// 위험 종목 선별.
//
// 목적은 두 가지다.
// ① 소비자 보호 — 시장이 이미 위험 신호를 낸 종목(투자경고·관리종목·코인 유의종목)에
//    대한 예측을 사서 따라 들어가는 상황을 줄인다
// ② 판정 신뢰성 — 정리매매·상장폐지 예정 종목은 검증 시한 전에 거래가 끊겨
//    판정 불가(전액 환불)로 끝날 가능성이 크다. 애초에 게시를 막는 편이 낫다
//
// 원천은 거래소·시장의 공식 지정이다. 우리가 임의로 "위험하다"고 판단하지 않는다 —
// 자체 판단은 근거를 대기 어렵고 종목 선정 개입(투자자문업 해석)으로 읽힐 수 있다.

/**
 * 위험 등급 (낮은 순).
 * - NONE: 지정 없음
 * - CAUTION: 투자주의 (KRX 시장경보 1단계) / 업비트 주의 종목 — 표시만
 * - WARNING: 투자경고·투자위험 (KRX 시장경보 2·3단계) / 업비트 유의 종목 —
 *   게시 가능하되 리포트에 경고를 노출하고 검수를 더 엄격히 본다
 * - DANGER: 관리종목·정리매매·상장폐지 예정·거래정지 — 신규 게시 차단
 */
export const RISK_LEVELS = ['NONE', 'CAUTION', 'WARNING', 'DANGER'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const ORDER: Record<RiskLevel, number> = { NONE: 0, CAUTION: 1, WARNING: 2, DANGER: 3 };

export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = {
  NONE: '',
  CAUTION: '투자주의',
  WARNING: '투자경고',
  DANGER: '거래 위험',
};

/** 구매자에게 보여줄 설명 — 무엇을 조심해야 하는지 */
export const RISK_LEVEL_NOTE: Record<RiskLevel, string> = {
  NONE: '',
  CAUTION: '거래소가 투자주의 종목으로 지정한 종목입니다. 단기 급등락 가능성이 있습니다.',
  WARNING:
    '거래소가 투자경고·유의 종목으로 지정한 종목입니다. 시세 변동성이 매우 크고 거래가 제한될 수 있습니다.',
  DANGER:
    '관리종목·정리매매 등으로 거래 자체가 중단될 수 있는 종목입니다. 신규 예측 게시가 제한됩니다.',
};

export function isRiskAtLeast(level: RiskLevel, min: RiskLevel): boolean {
  return ORDER[level] >= ORDER[min];
}

/** 신규 게시가 막히는 등급인가 */
export function blocksNewCard(level: RiskLevel): boolean {
  return level === 'DANGER';
}

/** 게시는 되지만 구매자에게 경고를 노출해야 하는 등급인가 */
export function requiresRiskDisclosure(level: RiskLevel): boolean {
  return isRiskAtLeast(level, 'WARNING');
}

/** 게시 차단 시 리서처에게 보여줄 사유 */
export function riskBlockMessage(ticker: string, name: string, note: string | null): string {
  return (
    `${name}(${ticker})은(는) 거래 위험 종목으로 지정되어 신규 예측을 게시할 수 없습니다` +
    `${note ? ` — ${note}` : ''}. ` +
    '거래정지·상장폐지 시 판정이 불가능해 전액 환불로 종료되기 때문입니다.'
  );
}

// ── 공급자 신호 → 위험 등급 매핑 ──────────────────────────────────────
//
// 업비트는 종목 목록(market/all)에 시장 경보 필드를 함께 주므로 자동 반영된다.
// 국내·미국 주식은 시세 공급자가 시장경보를 제공하지 않아 별도 소스가 필요하다
// (KRX 시장경보·관리종목 지정 공시). 소스 확정 전까지는 운영자 수동 설정
// (npm run risk:set)으로 채우고, 확정되면 이 매핑에 어댑터를 추가한다.

export interface ProviderRiskSignal {
  /** 거래 지원 종료·상장폐지 예정 */
  delisting?: boolean;
  /** 유의·경고 지정 */
  warning?: boolean;
  /** 주의 지정 */
  caution?: boolean;
  /** 지정 사유 (표시용) */
  note?: string;
}

export function toRiskLevel(signal: ProviderRiskSignal | undefined): RiskLevel {
  if (!signal) return 'NONE';
  if (signal.delisting) return 'DANGER';
  if (signal.warning) return 'WARNING';
  if (signal.caution) return 'CAUTION';
  return 'NONE';
}

/**
 * 위험 종목에 대한 리포트가 갖춰야 할 최소 요건.
 * 경고 등급 이상이면 본문에 리스크 고지가 있어야 한다 — 위험을 알리지 않은 채
 * 매수를 권하는 리포트가 이 플랫폼에서 팔리면 안 된다.
 */
const DISCLOSURE_PATTERN =
  /위험|리스크|손실|변동성|주의|유의|투자\s*판단|하락\s*가능|원금\s*손실|경고/;

export function hasRiskDisclosure(content: string): boolean {
  return DISCLOSURE_PATTERN.test(content);
}

/** 자산군별 위험 정보 원천 (문서·운영 안내용) */
export const RISK_SOURCE_NOTE: Record<AssetClass, string> = {
  KR_EQUITY: 'KRX 시장경보(투자주의·경고·위험)·관리종목 지정 — 현재 운영자 수동 등록',
  US_EQUITY: 'SEC 거래정지·상장폐지 통지 — 현재 운영자 수동 등록',
  CRYPTO: '업비트 market/all 시장 경보 필드 — 종목 동기화 시 자동 반영',
};
