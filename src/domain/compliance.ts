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
 * 검수에서 발견된 위험 수준 (무엇을 찾았는가).
 * - BLOCK: 명백한 위반 소견
 * - WARN: 확인이 필요한 소견
 * - PASS: 소견 없음
 * - UNAVAILABLE: AI 검수 실패(장애 등)
 */
export type ComplianceDecision = 'PASS' | 'WARN' | 'BLOCK' | 'UNAVAILABLE';

/**
 * 그래서 게시를 어떻게 할 것인가 (무엇을 할 것인가).
 * 위험 수준과 분리한 이유: 같은 BLOCK이라도 판단 주체에 따라 처리가 달라야 한다.
 * - REJECT: 즉시 게시 거절. **결정적 규칙이 잡은 BLOCK만** 여기 해당한다.
 *   오탐이 사실상 없는 표현만 규칙에 넣었으므로 사람 확인 없이 막아도 안전하다
 * - HOLD: 게시 보류 → 운영자 큐. AI가 낸 BLOCK·WARN, AI 장애가 여기 해당한다.
 *   AI 판단은 오탐 가능성이 있어 그것만으로 리서처의 게시를 죽이지 않는다 —
 *   대신 판매도 시작하지 않고 사람이 최종 결정한다
 * - PUBLISH: 즉시 게시
 */
export type ComplianceAction = 'PUBLISH' | 'HOLD' | 'REJECT';

export interface ComplianceResult {
  decision: ComplianceDecision;
  /** 게시 처리 방침 */
  action: ComplianceAction;
  findings: Finding[];
  /** 검수 주체 식별자 (rule / claude:모델명 / rule+claude:모델명) */
  reviewer: string;
  /** 운영자 검토가 필요한가 (action === 'HOLD') */
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

/**
 * 위험 수준 → 게시 처리 방침.
 * 규칙이 낸 BLOCK만 즉시 거절이고, AI가 낸 BLOCK은 보류다 (사람이 최종 결정).
 */
export function resolveAction(
  ruleDecision: Exclude<ComplianceDecision, 'UNAVAILABLE'>,
  finalDecision: ComplianceDecision,
): ComplianceAction {
  if (ruleDecision === 'BLOCK') return 'REJECT';
  return finalDecision === 'PASS' ? 'PUBLISH' : 'HOLD';
}

/** 게시 거절·보류 사유를 리서처에게 보여줄 메시지로 (심각도 표시 포함) */
export function findingMessages(findings: Finding[], severity?: Severity): string[] {
  return findings
    .filter((f) => !severity || f.severity === severity)
    .map(
      (f) =>
        `[${f.severity === 'BLOCK' ? '위반' : '확인 필요'} · ${RISK_CATEGORY_LABEL[f.category]}] ` +
        `${f.reason} (해당 부분: "${f.quote}")`,
    );
}

// ── 보류 대기 시간 ────────────────────────────────────────────────────
//
// 보류 중인 리포트는 판매가 멈춰 있다. 대기가 길어질수록 리서처의 손해가 커지고,
// 검증 시한이 짧은 카드(코인 최소 1일)는 승인 시점에 이미 게시 조건을 못 맞출 수 있다.
// 그래서 큐는 오래된 순으로 정렬하고, 경과 시간에 따라 눈에 띄게 표시한다.

/** 이 시간을 넘기면 주의 (반나절 안에는 답을 줘야 한다는 기준) */
export const HOLD_ATTENTION_HOURS = 6;
/** 이 시간을 넘기면 지연 — 단기 카드는 이미 가치를 잃었을 수 있다 */
export const HOLD_OVERDUE_HOURS = 24;

export type HoldUrgency = 'NORMAL' | 'ATTENTION' | 'OVERDUE';

export function holdUrgency(heldAt: Date, now: Date): HoldUrgency {
  const hours = (now.getTime() - heldAt.getTime()) / 3_600_000;
  if (hours >= HOLD_OVERDUE_HOURS) return 'OVERDUE';
  if (hours >= HOLD_ATTENTION_HOURS) return 'ATTENTION';
  return 'NORMAL';
}

/** 경과 시간을 사람이 읽는 표기로 ("42분 대기" / "3시간 대기" / "2일 5시간 대기") */
export function formatElapsed(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}분 대기`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 대기`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}일 대기` : `${days}일 ${rest}시간 대기`;
}

/**
 * 승인해도 게시가 안 될 수 있는 상태인가.
 * 시한이 이미 지났으면 승인 자체가 실패하고, 임박했으면 최소 시한 규칙에 걸릴 수 있다.
 */
export function deadlineRisk(
  deadline: Date | null | undefined,
  now: Date,
): 'NONE' | 'NEAR' | 'PASSED' {
  if (!deadline) return 'NONE';
  const hours = (deadline.getTime() - now.getTime()) / 3_600_000;
  if (hours <= 0) return 'PASSED';
  return hours <= 48 ? 'NEAR' : 'NONE';
}

/** 규칙 결과 + AI 결과 병합 (중복 카테고리는 규칙 쪽을 우선) */
export function mergeFindings(ruleFindings: Finding[], aiFindings: Finding[]): Finding[] {
  const seen = new Set(ruleFindings.map((f) => `${f.category}:${f.severity}`));
  return [
    ...ruleFindings,
    ...aiFindings.filter((f) => !seen.has(`${f.category}:${f.severity}`)),
  ];
}
