// 검수 정확도 측정 (순수 로직).
//
// 왜 필요한가: 지금까지 검수 시스템은 "무엇을 잡았는가"만 기록하고 "그게 맞았는가"는
// 기록하지 않았다. 정답 라벨이 없으면 오탐률도 미탐률도 알 수 없고, 규칙 하나를
// 고치는 것도, 더 싼 모델로 바꾸는 것도 전부 감으로 하게 된다.
//
// 정답 라벨의 원천은 운영자의 결정이다. 보류된 건을 승인했다면 그 소견은 게시를 막을
// 이유가 아니었다는 뜻이고, 반려했다면 맞게 잡은 것이다. 통과시킨 건이 나중에 강제
// 철회됐다면 그건 놓친 것이다. 이 세 가지가 각각 오탐·정탐·미탐이 된다.
//
// 이 모듈은 그 라벨을 집계해서 ① 오탐률(공급을 죽이고 있는가) ② 유형별·출처별 분해
// (고칠 곳이 정규식인가 프롬프트인가) ③ 프롬프트에 되먹일 오탐 사례를 만든다.

import type { ComplianceDecision, Finding, FindingSource, RiskCategory } from './compliance';

/**
 * 운영자가 내린 최종 결정.
 * - APPROVED: 보류 건을 게시 승인 (소견이 게시를 막을 이유는 아니었다)
 * - REJECTED: 보류 건을 반려 (소견이 맞았다)
 * - KEPT: 판매 중 리포트를 확인 후 유지
 * - TAKEDOWN: 판매 중 리포트를 강제 철회 (통과시킨 것이 잘못이었다)
 */
export const OPERATOR_VERDICTS = ['APPROVED', 'REJECTED', 'KEPT', 'TAKEDOWN'] as const;
export type OperatorVerdict = (typeof OPERATOR_VERDICTS)[number];

export const OPERATOR_VERDICT_LABEL: Record<OperatorVerdict, string> = {
  APPROVED: '게시 승인',
  REJECTED: '반려',
  KEPT: '게시 유지',
  TAKEDOWN: '강제 철회',
};

/** 운영자 결정이 붙은 검수 1건 (DB 행을 도메인 형태로 옮긴 것) */
export interface LabeledReview {
  decision: ComplianceDecision;
  findings: Finding[];
  verdict: OperatorVerdict | null;
  /**
   * 승인·유지 시에만 의미가 있다. 운영자가 "지적 자체는 타당했다(경미해서 승인)"고
   * 표시했는지 여부. 기본값(false)이 오탐인 이유: 승인의 대다수는 과잉 지적이고,
   * 예외를 표시하게 하는 편이 운영자의 클릭 수가 적다.
   */
  findingsValid: boolean | null;
  /**
   * 반려·철회 시 운영자가 지목한 실제 위반 유형.
   * 비어 있으면 "검수가 지적한 그대로"로 해석한다 (운영자가 별도 입력을 하지 않은 경우).
   * 채워져 있으면 유형 단위로 정탐/오탐/미탐을 가를 수 있다 —
   * 반려된 건이라도 검수가 엉뚱한 유형을 짚었을 수 있기 때문.
   */
  actualCategories: RiskCategory[];
  /** 반려·철회 사유 (오탐 사례를 프롬프트에 되먹일 때 설명으로 쓴다) */
  operatorReason?: string | null;
}

/**
 * 검수 1건의 결과 판정.
 * MINOR를 오탐과 분리한 이유: 지적 자체는 옳았지만 게시를 막을 정도는 아닌 경우가 있고,
 * 이건 "규칙을 지워야 한다"가 아니라 "심각도를 낮춰야 한다"는 신호라 처방이 다르다.
 */
export type ScreeningOutcome =
  | 'TRUE_POSITIVE'
  | 'MINOR'
  | 'FALSE_POSITIVE'
  | 'FALSE_NEGATIVE'
  | 'TRUE_NEGATIVE'
  | 'UNLABELED';

export const OUTCOME_LABEL: Record<Exclude<ScreeningOutcome, 'UNLABELED'>, string> = {
  TRUE_POSITIVE: '정탐 (막아야 했고 막았다)',
  MINOR: '경미 (지적은 타당, 게시는 허용)',
  FALSE_POSITIVE: '오탐 (막지 말았어야 했다)',
  FALSE_NEGATIVE: '미탐 (통과시켰다가 철회)',
  TRUE_NEGATIVE: '정상 통과 (확인 후 유지)',
};

/** 소견이 있어 실제로 게시가 보류된 건인가 */
function wasHeld(r: LabeledReview): boolean {
  return r.findings.length > 0;
}

export function classifyReview(r: LabeledReview): ScreeningOutcome {
  if (!r.verdict) return 'UNLABELED';
  // AI 검수 실패로 보류된 건은 정확도 표본이 아니다 — 판단 자체가 없었으므로
  // 맞고 틀림을 따질 대상이 없다 (가용성 문제로 별도 집계한다).
  if (r.decision === 'UNAVAILABLE' && !wasHeld(r)) return 'UNLABELED';

  if (!wasHeld(r)) {
    // 소견 없이 통과된 건 — 사후에 문제가 드러났는지만 본다
    if (r.verdict === 'TAKEDOWN') return 'FALSE_NEGATIVE';
    if (r.verdict === 'KEPT') return 'TRUE_NEGATIVE';
    return 'UNLABELED';
  }

  if (r.verdict === 'REJECTED' || r.verdict === 'TAKEDOWN') return 'TRUE_POSITIVE';
  return r.findingsValid ? 'MINOR' : 'FALSE_POSITIVE';
}

// ── 유형별·출처별 분해 ────────────────────────────────────────────────

export interface BreakdownStat<K extends string> {
  key: K;
  /** 이 키로 지적한 라벨 건수 */
  flagged: number;
  /** 운영자가 실제 위반으로 인정 */
  confirmed: number;
  /** 잘못 지적 */
  falsePositive: number;
  /** 운영자가 지목했는데 검수가 못 잡은 유형 (유형별 집계에서만 발생) */
  missed: number;
}

type Bucket = { flagged: number; confirmed: number; falsePositive: number; missed: number };

function bucket(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) {
    b = { flagged: 0, confirmed: 0, falsePositive: 0, missed: 0 };
    map.set(key, b);
  }
  return b;
}

/**
 * 소견 하나하나가 맞았는지를 가른다.
 * 반려된 건이라도 운영자가 실제 위반 유형을 따로 지목했다면, 거기 없는 유형은 오탐이다.
 */
function confirmedCategories(r: LabeledReview): Set<RiskCategory> | null {
  if (r.verdict === 'REJECTED' || r.verdict === 'TAKEDOWN') {
    if (r.actualCategories.length === 0) return null; // 별도 입력 없음 → 소견 전부 인정
    return new Set(r.actualCategories);
  }
  return r.findingsValid ? null : new Set(); // 승인: 타당 표시면 전부 인정, 아니면 전부 오탐
}

export interface AccuracySummary {
  /** 운영자 결정이 붙은 표본 수 */
  labeled: number;
  /** 그중 소견이 있어 보류된 건 (정탐률의 분모) */
  held: number;
  truePositive: number;
  minor: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  /** 보류한 것 중 실제로 막아야 했던 비율 */
  precision: number | null;
  /** 보류한 것 중 막지 말았어야 했던 비율 — 이 값이 높으면 공급이 죽는다 */
  falsePositiveRate: number | null;
  byCategory: BreakdownStat<RiskCategory>[];
  bySource: BreakdownStat<FindingSource | 'unknown'>[];
}

export function summarizeAccuracy(rows: LabeledReview[]): AccuracySummary {
  const counts: Record<Exclude<ScreeningOutcome, 'UNLABELED'>, number> = {
    TRUE_POSITIVE: 0,
    MINOR: 0,
    FALSE_POSITIVE: 0,
    FALSE_NEGATIVE: 0,
    TRUE_NEGATIVE: 0,
  };
  const byCategory = new Map<string, Bucket>();
  const bySource = new Map<string, Bucket>();
  let labeled = 0;

  for (const r of rows) {
    const outcome = classifyReview(r);
    if (outcome === 'UNLABELED') continue;
    labeled += 1;
    counts[outcome] += 1;

    const confirmed = confirmedCategories(r);
    const flaggedCategories = new Set<RiskCategory>();

    for (const f of r.findings) {
      flaggedCategories.add(f.category);
      const ok = confirmed === null || confirmed.has(f.category);
      for (const b of [bucket(byCategory, f.category), bucket(bySource, f.source ?? 'unknown')]) {
        b.flagged += 1;
        if (ok) b.confirmed += 1;
        else b.falsePositive += 1;
      }
    }

    // 운영자가 지목했는데 소견에 없던 유형 = 이 유형은 검수가 못 잡는다
    for (const c of r.actualCategories) {
      if (!flaggedCategories.has(c)) bucket(byCategory, c).missed += 1;
    }
  }

  const held = counts.TRUE_POSITIVE + counts.MINOR + counts.FALSE_POSITIVE;
  const toList = <K extends string>(map: Map<string, Bucket>): BreakdownStat<K>[] =>
    [...map.entries()]
      .map(([key, b]) => ({ key: key as K, ...b }))
      // 오탐이 많은 것부터 — 고칠 우선순위가 그 순서다
      .sort((a, b) => b.falsePositive - a.falsePositive || b.flagged - a.flagged);

  return {
    labeled,
    held,
    truePositive: counts.TRUE_POSITIVE,
    minor: counts.MINOR,
    falsePositive: counts.FALSE_POSITIVE,
    falseNegative: counts.FALSE_NEGATIVE,
    trueNegative: counts.TRUE_NEGATIVE,
    precision: held > 0 ? counts.TRUE_POSITIVE / held : null,
    falsePositiveRate: held > 0 ? counts.FALSE_POSITIVE / held : null,
    byCategory: toList<RiskCategory>(byCategory),
    bySource: toList<FindingSource | 'unknown'>(bySource),
  };
}

// ── 되먹임: 오탐 사례를 프롬프트 보정 자료로 ──────────────────────────
//
// 이 플랫폼에서 검수 품질의 병목은 미탐이 아니라 오탐이다 (사후 철회로 미탐은 복구되지만,
// 오탐은 정상 리서처의 게시를 막아 공급을 잃는다). 그래서 운영자가 "이건 오탐"이라고
// 판정한 사례를 모아 AI에게 "이런 건 지적하지 마라"로 되돌려주는 것이 가장 효과가 크다.
//
// 규칙(source: 'rule')이 낸 오탐은 프롬프트로 고칠 수 없으므로 제외한다 —
// 그건 정규식을 직접 손봐야 하고, byCategory/bySource 집계가 그 신호를 준다.

export interface CalibrationExample {
  category: RiskCategory;
  /** 실제로 지적됐던 원문 조각 */
  quote: string;
  /** 왜 오탐이었는지 (운영자 사유가 있으면 그것) */
  note: string;
}

/** 인용문이 길면 프롬프트만 부풀고 학습 효과는 없다 */
const QUOTE_LIMIT = 120;
const DEFAULT_NOTE = '운영자 검토 결과 정상 표현으로 판정됨';

export function calibrationExamples(rows: LabeledReview[], limit = 8): CalibrationExample[] {
  const out: CalibrationExample[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    if (classifyReview(r) !== 'FALSE_POSITIVE') continue;
    for (const f of r.findings) {
      if (f.source === 'rule') continue; // 정규식 오탐은 프롬프트로 고칠 수 없다
      const quote = f.quote.trim().slice(0, QUOTE_LIMIT);
      if (!quote) continue;
      const key = `${f.category}:${quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        category: f.category,
        quote,
        note: r.operatorReason?.trim() || DEFAULT_NOTE,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
