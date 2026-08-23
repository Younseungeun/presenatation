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

import { CATEGORY_RISK_TIER, type Finding, type RiskCategory, type ScreeningInput } from './compliance';
import type { CorpusItem, CorpusKind } from './__fixtures__/screeningCorpus';

export type CategoryRiskTier = (typeof CATEGORY_RISK_TIER)[RiskCategory];

/**
 * 평가 대상. **검수 입력 하나를 받아 소견을 내는 것**이면 무엇이든 된다.
 *
 * 원래는 `(text: string) => Finding[]`였다. 문장만 받는 자로는 잴 수 없는 것이 있어서
 * 넓혔다 — 본문 결론과 예측 카드가 어긋나는지(`CARD_MISMATCH`)는 **문장의 성질이 아니라
 * 문서와 카드를 맞대본 결과**다. 카드가 들어올 자리가 없으면 그 능력은 영원히 측정 불가로
 * 남고, 측정할 수 없는 것은 개선했는지도 알 수 없다.
 *
 * "규칙이든 임베딩이든 LLM이든 같은 잣대로 잰다"는 원칙은 그대로다. 입력의 폭만 넓어졌다.
 */
export type Detector = (input: ScreeningInput) => Finding[];

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

/**
 * 위험 성격별 집계 — 미탐의 **비용**이 다른 것끼리 묶어 따로 센다.
 * 총합 탐지율은 "규제 위반만 골라 새고 있는" 상태를 가릴 수 있다.
 */
export interface TierStat {
  tier: CategoryRiskTier;
  total: number;
  detected: number;
  recall: number;
}

export interface EvalReport {
  /** 채점된 항목 수 — 관측 전용(probe)은 빠진다 */
  total: number;
  /**
   * 관측 전용 항목과 그 결과. 채점하지 않고 **탐지기가 뭐라고 했는지만** 나른다.
   * 정답을 모르는 경계 사례가 여기 온다 (CorpusItem.probe 참고).
   */
  probes: { item: CorpusItem; findings: Finding[] }[];
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
  /**
   * 정상 항목 중 **운영자 큐로 갈** 비율 = 이 설계가 만들어내는 사람 손의 양.
   *
   * 지금은 즉시 거절 오탐이 0이라 오탐률과 같은 값이지만, 뜻이 다르므로 따로 낸다 —
   * 저쪽은 "얼마나 틀리는가"이고 이쪽은 "사람이 얼마나 봐야 하는가"다.
   * 거절 오탐이 생기는 날 두 값이 갈라지고, 그때 갈라지는 것을 봐야 한다.
   *
   * ⚠ **리포트 단위 보류율이 아니다.** 문장 하나라도 걸리면 리포트 전체가 보류되므로,
   * 문장이 여러 개인 실제 리포트의 보류율은 이 값보다 높다.
   */
  holdRate: number;
  byKind: KindStat[];
  byCategory: CategoryStat[];
  byTier: TierStat[];
  /** 놓친 위반 문장 (무엇을 못 잡는지 눈으로 봐야 다음 수가 나온다) */
  misses: CorpusItem[];
  /** 잘못 잡은 정상 문장 */
  falsePositives: { item: CorpusItem; findings: Finding[] }[];
}

const VIOLATION_KINDS: CorpusKind[] = [
  // 문장 단위
  'literal',
  'paraphrase',
  'evasion',
  // 문서 단위 — 본문과 카드가 어긋나는 방식
  'direction_flip',
  'magnitude_gap',
  'horizon_gap',
  'flip_under_risk',
];

/**
 * **문장 항목에 채우는 기본 카드** (12차 M-1).
 *
 * 예전에는 `방향 상승` 하나만 채우고 나머지를 비워 뒀다. 근거는 "카드를 보는 규칙이
 * 문장 기준선에 끼어들지 않게"였고 그 목적 자체는 옳았는데, **부작용이 훨씬 컸다**:
 *
 *   운영에서 예측 카드는 **필수 입력**이라 언제나 채워져 있다. 그런데 학생 모델의 입력
 *   첫 줄이 그 카드다(`buildStudentText`). 카드가 빈 입력으로만 학습하고 재면,
 *   **운영에 존재하지 않는 모양**으로 채택 판정을 하게 된다.
 *
 * 실측(2026-08-20): 같은 위반 문장 52건에 카드만 채웠더니 정답 라벨 점수가
 * 중앙 56% → 26%, 최고 81% → **49%** 로 내려가 t=0.5 에서 **탐지 0건**이 됐다.
 * 능력을 잃은 것이 아니라 눈금이 통째로 밀린 것이다(t=0.25 에서 51.9% / 오탐 0%).
 *
 * 그래서 **현실적이면서 규칙이 조용한** 카드를 채운다:
 * - 12% / 90일 — 국내주식 90일 상한(약 87%)에 한참 못 미쳐 UNREALISTIC_TARGET 이 안 뜬다
 * - 하한(1.2·σ·√일수)도 넘는다 — 게시 관문이 거절할 조합이면 코퍼스가 비현실이 된다
 * - 신뢰도 5 — 사다리 한가운데
 *
 * ⚠ 이 값을 바꾸면 학생 성적이 통째로 움직인다. 바꾸는 날 `eval:student -- --sweep`으로
 * 임계값을 다시 정하고 커버리지 스냅숏을 다시 떠야 한다.
 */
export interface NeutralCard {
  direction: 'UP' | 'DOWN';
  targetType: 'RETURN_PCT' | 'TARGET_PRICE';
  magnitudePct: number;
  horizonDays: number;
  confidence: number;
}

/**
 * @근거 설계 — 운영에 실제로 존재하는 모양이면서 **규칙이 조용한** 조합으로 골랐다.
 *   12%/90일은 국내주식 90일 상한(약 87%)과 하한(1.2·σ·√90) 사이에 넉넉히 들어가
 *   UNREALISTIC_TARGET 이 안 뜨고 게시 관문도 통과한다. 신뢰도 5는 사다리 한가운데.
 *   특정 값이 옳아서가 아니라 **비어 있으면 안 되기 때문**에 있는 값이다 (12차 M-1).
 */
export const NEUTRAL_CARD: NeutralCard = {
  direction: 'UP',
  targetType: 'RETURN_PCT',
  magnitudePct: 12,
  horizonDays: 90,
  confidence: 5,
};

/**
 * 코퍼스 항목을 검수 입력으로 편다.
 *
 * 문장 항목은 카드가 없다 — 그때는 `NEUTRAL_CARD`를 채운다(위 주석).
 * 문서 항목은 자기 카드를 그대로 쓴다.
 *
 * @param card 기본 카드를 덮어쓸 값. **학습 데이터 생성이 카드를 굴리는 데 쓴다** —
 *   한 가지 카드로만 학습하면 다른 카드에서 또 눈금이 밀린다.
 */
export function corpusInput(
  item: CorpusItem,
  card: Partial<NeutralCard> = {},
): ScreeningInput {
  const c = { ...NEUTRAL_CARD, ...card };
  return {
    title: item.title ?? '',
    summary: item.summary ?? '',
    content: item.text,
    assetClass: 'KR_EQUITY',
    assetName: '',
    direction: item.card?.direction ?? c.direction,
    targetType: item.card ? item.card.targetType : c.targetType,
    targetLabel: item.card?.targetLabel,
    magnitudePct: item.card ? item.card.magnitudePct : c.magnitudePct,
    horizonDays: item.card ? item.card.horizonDays : c.horizonDays,
    confidence: item.card ? item.card.confidence : c.confidence,
  };
}

export function evaluate(detector: Detector, corpus: CorpusItem[]): EvalReport {
  // 관측 전용 항목은 **모든 집계에서 빠진다.** 정답을 모르는 항목을 분모에 넣으면
  // 그 임의의 라벨이 지표를 흔들고, 지표가 흔들리면 변경 전후 비교가 성립하지 않는다.
  const probes = corpus.filter((i) => i.probe);
  const scored = corpus.filter((i) => !i.probe);

  const results: ItemResult[] = scored.map((item) => {
    const findings = detector(corpusInput(item));
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

  const byKind: KindStat[] = [...new Set(scored.map((i) => i.kind))].map((kind) => {
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

  const byTier: TierStat[] = [
    ...new Set(violations.map((r) => CATEGORY_RISK_TIER[r.item.violation as RiskCategory])),
  ].map((tier) => {
    const rows = violations.filter(
      (r) => CATEGORY_RISK_TIER[r.item.violation as RiskCategory] === tier,
    );
    const detected = rows.filter((r) => r.detected).length;
    return { tier, total: rows.length, detected, recall: detected / rows.length };
  });

  return {
    total: scored.length,
    probes: probes.map((item) => ({ item, findings: detector(corpusInput(item)) })),
    violations: violations.length,
    negatives: negatives.length,
    recall: violations.length ? detectedCount / violations.length : 0,
    falsePositiveRate: negatives.length ? fpCount / negatives.length : 0,
    blockingFalsePositives: negatives.filter(
      (r) => r.falsePositive && r.findings.some((f) => f.severity === 'BLOCK' && f.source === 'rule'),
    ).length,
    wrongCategory: violations.filter((r) => r.wrongCategory).length,
    // 규칙 BLOCK은 거절되어 큐에 오지 않는다 — 사람 손이 가는 것은 나머지다
    holdRate: negatives.length
      ? negatives.filter(
          (r) =>
            r.falsePositive &&
            !r.findings.some((f) => f.severity === 'BLOCK' && f.source === 'rule'),
        ).length / negatives.length
      : 0,
    byKind,
    byCategory,
    byTier,
    misses: violations.filter((r) => !r.detected).map((r) => r.item),
    falsePositives: negatives
      .filter((r) => r.falsePositive)
      .map((r) => ({ item: r.item, findings: r.findings })),
  };
}
