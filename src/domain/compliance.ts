// 게시 전 컴플라이언스 검수 (순수 로직).
//
// 목적: 리서처가 게시하려는 리포트에서 규제 위반 소지가 있는 표현을 게시 시점에 차단·경고한다.
// 우리 사업의 최대 리스크가 규제(손실보전 금지·투자자문업 경계)이므로, 그 리스크를
// 콘텐츠 단계에서 줄이는 것이 목적이다 (docs/legal-consultation.md).
//
// 2단 구조:
//  1) 결정적 규칙(rule) — 명백한 금지 표현. API 없이 즉시 판정, 오탐이 거의 없는 것만 담는다
//  2) AI 판단(screener) — 문맥이 필요한 사안. 규칙이 못 잡는 우회 표현·뉘앙스를 본다
// 규칙이 BLOCK을 내면 AI 호출 없이 즉시 차단한다 (비용·지연 절약).

import type { AssetClass } from './constants';

/** 위반 유형 — 각 항목은 특정 규제·정책 조항에 대응한다 */
export const RISK_CATEGORIES = [
  'PROFIT_GUARANTEE', // 수익 보장·손실 보전 약속 (자본시장법 손실보전 금지)
  'PRIVATE_INFO', // 미공개 중요정보 정황 (내부자 정보 이용)
  'RUMOR', // 출처 불명 풍문·시세조종성 표현
  'SOLICIT_CONTACT', // 1:1 상담·외부 채널 유도 (투자자문업 경계)
  'UNSUPPORTED_CLAIM', // 근거 없는 단정 (품질 문제 — 경고만)
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_CATEGORY_LABEL: Record<RiskCategory, string> = {
  PROFIT_GUARANTEE: '수익 보장·손실 보전 표현',
  PRIVATE_INFO: '미공개 중요정보 정황',
  RUMOR: '출처 불명 풍문',
  SOLICIT_CONTACT: '1:1 상담·외부 채널 유도',
  UNSUPPORTED_CLAIM: '근거 없는 단정',
};

/** BLOCK: 게시 차단 / WARN: 게시 허용하되 운영자 검토 대상 */
export type Severity = 'BLOCK' | 'WARN';

export interface Finding {
  category: RiskCategory;
  severity: Severity;
  /** 문제가 된 원문 일부 (리서처에게 어디를 고쳐야 하는지 보여주기 위함) */
  quote: string;
  /** 왜 문제인지 — 리서처가 수정할 수 있게 설명 */
  reason: string;
}

/**
 * 검수 결정.
 * - BLOCK: 게시 불가. 리서처가 문구를 고쳐 다시 시도해야 한다
 * - WARN: 게시는 되지만 운영자 검토 큐에 올라간다
 * - PASS: 통과
 * - UNAVAILABLE: AI 검수 실패(장애 등). 게시는 허용하되 운영자 검토 대상 —
 *   검수 실패로 게시 자체를 막으면 외부 장애가 서비스 중단으로 번지기 때문
 */
export type ComplianceDecision = 'PASS' | 'WARN' | 'BLOCK' | 'UNAVAILABLE';

export interface ComplianceResult {
  decision: ComplianceDecision;
  findings: Finding[];
  /** 검수 주체 식별자 (rule / claude:모델명 / rule+claude:모델명) */
  reviewer: string;
  /** 운영자 검토가 필요한가 (WARN·UNAVAILABLE) */
  needsOperatorReview: boolean;
  /** AI 검수 토큰 사용량 — 비용 측정·숙고량 신호용 (규칙만 돌았으면 없음) */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ScreeningInput {
  title: string;
  summary: string;
  content: string;
  assetClass: AssetClass;
  assetName: string;
  /** 예측 방향 — 하락 예측은 시세조종성 표현 여부를 더 민감하게 본다 */
  direction: 'UP' | 'DOWN';
}

// ── 1단계: 결정적 규칙 ────────────────────────────────────────────────
//
// 오탐이 사실상 없는 표현만 BLOCK으로 둔다. 애매한 것은 규칙에 넣지 않고
// AI 판단에 맡긴다 — 규칙의 오탐은 정상 리서처의 게시를 막아 공급을 해치기 때문.

interface Rule {
  category: RiskCategory;
  severity: Severity;
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  {
    category: 'PROFIT_GUARANTEE',
    severity: 'BLOCK',
    pattern: /원금\s*보장|손실\s*(을\s*)?보전|수익(률)?\s*(을\s*)?보장|절대\s*손해\s*(는\s*)?없|무조건\s*(수익|상승|오릅|먹)/,
    reason:
      '수익·원금을 보장하는 표현은 자본시장법상 손실보전·이익보장 금지에 저촉될 수 있어 게시할 수 없습니다.',
  },
  {
    category: 'PROFIT_GUARANTEE',
    severity: 'BLOCK',
    pattern: /100\s*%\s*(수익|상승|성공|적중)|확정\s*수익/,
    reason: '확정 수익을 단정하는 표현은 사용할 수 없습니다. 전망·근거 형태로 서술해주세요.',
  },
  {
    category: 'SOLICIT_CONTACT',
    severity: 'BLOCK',
    pattern:
      /카카오\s*톡|카톡|오픈\s*채팅|오픈\s*카톡|텔레그램|telegram|리딩\s*방|단톡방|개인\s*(상담|문의|연락)|1\s*:\s*1\s*(상담|문의|코칭)/i,
    reason:
      '1:1 상담·외부 채널 유도는 투자자문업 영역으로 해석될 수 있어 금지됩니다. 리포트는 불특정 다수 대상 분석만 담아야 합니다.',
  },
  {
    category: 'PRIVATE_INFO',
    severity: 'BLOCK',
    pattern:
      /내부\s*(관계자|직원|정보통)|미공개\s*(정보|공시|실적)|공시\s*(되기\s*)?전에\s*(입수|확인)|지인\s*(을\s*통해|한테)\s*들은/,
    reason:
      '미공개 중요정보를 시사하는 표현은 자본시장법 위반 소지가 있어 게시할 수 없습니다. 공개 자료만 근거로 사용해주세요.',
  },
  {
    category: 'RUMOR',
    severity: 'WARN',
    pattern: /카더라|~?라는\s*소문|소문\s*에\s*의하면|찌라시/,
    reason: '출처가 불명확한 풍문성 표현입니다. 확인 가능한 공개 자료로 대체해주세요.',
  },
];

/** 원문에서 매칭 구간 주변을 잘라 인용문으로 만든다 (리서처가 위치를 찾을 수 있게) */
function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 15);
  const end = Math.min(text.length, index + length + 15);
  // 제목·요약·본문을 이어 붙여 검사하므로 줄바꿈이 섞인다 — 한 줄로 정리해 읽기 쉽게
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

/** 결정적 규칙 검사 — API 호출 없이 즉시 실행 */
export function applyRules(input: ScreeningInput): Finding[] {
  const text = `${input.title}\n${input.summary}\n${input.content}`;
  const findings: Finding[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    findings.push({
      category: rule.category,
      severity: rule.severity,
      quote: quoteAround(text, match.index, match[0].length),
      reason: rule.reason,
    });
  }
  return findings;
}

// ── 결정 로직 ─────────────────────────────────────────────────────────

/** 발견 목록 → 최종 결정 (BLOCK 하나라도 있으면 차단) */
export function decide(findings: Finding[]): Exclude<ComplianceDecision, 'UNAVAILABLE'> {
  if (findings.some((f) => f.severity === 'BLOCK')) return 'BLOCK';
  if (findings.length > 0) return 'WARN';
  return 'PASS';
}

/** 결정 → 게시 가능 여부 */
export function blocksPublish(decision: ComplianceDecision): boolean {
  return decision === 'BLOCK';
}

/** 게시 차단 시 리서처에게 보여줄 메시지 */
export function blockMessages(findings: Finding[]): string[] {
  return findings
    .filter((f) => f.severity === 'BLOCK')
    .map((f) => `[${RISK_CATEGORY_LABEL[f.category]}] ${f.reason} (해당 부분: "${f.quote}")`);
}

/** 규칙 결과 + AI 결과 병합 (중복 카테고리는 규칙 쪽을 우선) */
export function mergeFindings(ruleFindings: Finding[], aiFindings: Finding[]): Finding[] {
  const seen = new Set(ruleFindings.map((f) => `${f.category}:${f.severity}`));
  return [
    ...ruleFindings,
    ...aiFindings.filter((f) => !seen.has(`${f.category}:${f.severity}`)),
  ];
}
