// 검수 성능 평가 (순수 로직).
//
// 어떤 탐지기(정규식 규칙 / 학습 표현 / 앞으로의 임베딩·분류기)든 같은 잣대로 재기 위한
// 공통 하네스다. 탐지기를 "문장 → 소견 목록" 함수로만 보기 때문에, 구현이 무엇으로
// 바뀌어도 이 파일은 그대로 쓴다.
//
// 이 프로젝트에서 중요한 수치는 두 개다:
//  ① 오탐률 — 정상 리포트를 얼마나 붙잡는가. 높으면 공급이 죽는다 (최우선 지표)
//  ② 종류별 탐지율 — 직설/패러프레이즈/회피를 각각 얼마나 잡는가.
//     전체 탐지율 하나로는 "정규식이 직설만 잡고 있다"는 사실이 숨는다.

import type { Finding, RiskCategory } from './compliance';
import type { CorpusItem, CorpusKind } from './__fixtures__/screeningCorpus';

/** 평가 대상. 문장 하나를 받아 소견을 내는 것이면 무엇이든 된다 */
export type Detector = (text: string) => Finding[];

export interface ItemResult {
  item: CorpusItem;
  findings: Finding[];
  /** 위반 문장을 올바른 유형으로 잡았는가 */
  detected: boolean;
  /** 정상 문장인데 소견이 나왔는가 */
  falsePositive: boolean;
  /** 위반은 잡았으나 유형을 잘못 짚었는가 (반쯤 맞은 것으로 따로 센다) */
  wrongCategory: boolean;
}

export interface KindStat {
  kind: CorpusKind;
  total: number;
  /** 위반 종류: 잡은 수 / 정상 종류: 오탐 수 */
  hit: number;
  rate: number;
}

export interface CategoryStat {
  category: RiskCategory;
  total: number;
  detected: number;
  recall: number;
}

export interface EvalReport {
  total: number;
  violations: number;
  negatives: number;
  /** 위반 문장 중 올바른 유형으로 잡은 비율 */
  recall: number;
  /** 정상 문장 중 잘못 잡은 비율 — 이 값이 높으면 공급이 죽는다 */
  falsePositiveRate: number;
  /**
   * 그중 **즉시 거절**을 유발한 건수 (규칙이 낸 BLOCK 오탐).
   * 이 값은 0이어야 한다 — 보류 오탐은 운영자가 승인으로 되살릴 수 있지만,
   * 거절 오탐은 사람 확인 없이 정상 리포트를 죽인다.
   */
  blockingFalsePositives: number;
  /** 위반은 알아봤지만 유형을 잘못 짚은 건수 */
  wrongCategory: number;
  byKind: KindStat[];
  byCategory: CategoryStat[];
  /** 놓친 위반 문장 (무엇을 못 잡는지 눈으로 봐야 다음 수가 나온다) */
  misses: CorpusItem[];
  /** 잘못 잡은 정상 문장 */
  falsePositives: { item: CorpusItem; findings: Finding[] }[];
}

const VIOLATION_KINDS: CorpusKind[] = ['literal', 'paraphrase', 'evasion'];

export function evaluate(detector: Detector, corpus: CorpusItem[]): EvalReport {
  const results: ItemResult[] = corpus.map((item) => {
    const findings = detector(item.text);
    const categories = new Set(findings.map((f) => f.category));
    // 종목 위험은 문장과 무관한 신호라 문장 평가에서 제외한다
    categories.delete('RISKY_INSTRUMENT');
    categories.delete('MISSING_DISCLOSURE');

    if (item.violation === null) {
      return {
        item,
        findings,
        detected: false,
        falsePositive: categories.size > 0,
        wrongCategory: false,
      };
    }
    const detected = categories.has(item.violation);
    return {
      item,
      findings,
      detected,
      falsePositive: false,
      wrongCategory: !detected && categories.size > 0,
    };
  });

  const violations = results.filter((r) => r.item.violation !== null);
  const negatives = results.filter((r) => r.item.violation === null);
  const detectedCount = violations.filter((r) => r.detected).length;
  const fpCount = negatives.filter((r) => r.falsePositive).length;

  const byKind: KindStat[] = [...new Set(corpus.map((i) => i.kind))].map((kind) => {
    const rows = results.filter((r) => r.item.kind === kind);
    const isViolation = VIOLATION_KINDS.includes(kind);
    const hit = rows.filter((r) => (isViolation ? r.detected : r.falsePositive)).length;
    return { kind, total: rows.length, hit, rate: rows.length ? hit / rows.length : 0 };
  });

  const byCategory: CategoryStat[] = [
    ...new Set(violations.map((r) => r.item.violation as RiskCategory)),
  ].map((category) => {
    const rows = violations.filter((r) => r.item.violation === category);
    const detected = rows.filter((r) => r.detected).length;
    return { category, total: rows.length, detected, recall: detected / rows.length };
  });

  return {
    total: corpus.length,
    violations: violations.length,
    negatives: negatives.length,
    recall: violations.length ? detectedCount / violations.length : 0,
    falsePositiveRate: negatives.length ? fpCount / negatives.length : 0,
    blockingFalsePositives: negatives.filter(
      (r) => r.falsePositive && r.findings.some((f) => f.severity === 'BLOCK' && f.source === 'rule'),
    ).length,
    wrongCategory: violations.filter((r) => r.wrongCategory).length,
    byKind,
    byCategory,
    misses: violations.filter((r) => !r.detected).map((r) => r.item),
    falsePositives: negatives
      .filter((r) => r.falsePositive)
      .map((r) => ({ item: r.item, findings: r.findings })),
  };
}
