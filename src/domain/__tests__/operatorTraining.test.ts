import { describe, expect, it } from 'vitest';
import type { Finding, RiskCategory } from '../compliance';
import { summarizeOperatorExamples, toOperatorLabels } from '../operatorTraining';
import type { LabeledReview } from '../screeningAccuracy';

// 운영자 판정이 학습 자료가 되는 규칙. **여기서 라벨을 잘못 옮기면 모델이 조용히
// 틀린 것을 배우고**, 그 원인은 성능 저하로만 나타나 찾을 수 없다.

const finding = (category: RiskCategory): Finding => ({
  category,
  severity: 'WARN',
  quote: '…',
  reason: '…',
  source: 'rule',
});

const review = (r: Partial<LabeledReview>): LabeledReview => ({
  decision: 'WARN',
  findings: [],
  verdict: null,
  findingsValid: null,
  actualCategories: [],
  ...r,
});

describe('운영자 판정 → 학습 라벨', () => {
  it('오탐은 라벨 없는 자료가 된다 — "이건 정상이다"', () => {
    // 막았다가 승인 = 막지 말았어야 했다. 가장 값진 자료다
    const out = toOperatorLabels(
      review({ findings: [finding('SOLICIT_CONTACT')], verdict: 'APPROVED', findingsValid: false }),
    );
    expect(out).toEqual({ kind: 'operator_false_positive', labels: [] });
  });

  it('미탐은 운영자가 지목한 유형으로 학습한다', () => {
    const out = toOperatorLabels(
      review({ decision: 'PASS', findings: [], verdict: 'TAKEDOWN', actualCategories: ['PROFIT_GUARANTEE'] }),
    );
    expect(out).toEqual({ kind: 'operator_missed', labels: ['PROFIT_GUARANTEE'] });
  });

  it('미탐인데 유형을 안 골랐으면 **자료로 쓰지 않는다**', () => {
    // 다중 라벨 BCE 라 빈 라벨은 곧 "아니다"를 가르치는 것이다.
    // 위반 문장에 빈 라벨을 붙이면 그 위반을 **정상으로** 학습시킨다
    expect(
      toOperatorLabels(review({ decision: 'PASS', findings: [], verdict: 'TAKEDOWN', actualCategories: [] })),
    ).toBeNull();
  });

  it('경미는 자료가 되지 않는다 — 라벨이 아니라 심각도의 문제다', () => {
    expect(
      toOperatorLabels(
        review({ findings: [finding('UNSUPPORTED_CLAIM')], verdict: 'APPROVED', findingsValid: true }),
      ),
    ).toBeNull();
  });

  it('판정이 없으면 아무것도 만들지 않는다', () => {
    expect(toOperatorLabels(review({ findings: [finding('RUMOR')] }))).toBeNull();
  });

  it('정탐은 기본으로 빼고, 켜면 넣는다', () => {
    const r = review({ findings: [finding('RUMOR')], verdict: 'REJECTED' });
    expect(toOperatorLabels(r)).toBeNull();
    expect(toOperatorLabels(r, { includeConfirmed: true })).toEqual({
      kind: 'operator_confirmed',
      labels: ['RUMOR'],
    });
  });

  it('학생 라벨 공간 밖의 유형은 버린다', () => {
    // RISKY_INSTRUMENT 는 종목 속성에서 오는 것이라 본문으로 배울 수 없다
    expect(
      toOperatorLabels(
        review({ decision: 'PASS', findings: [], verdict: 'TAKEDOWN', actualCategories: ['RISKY_INSTRUMENT'] }),
      ),
    ).toBeNull();
  });

  it('자료 구성을 세어 준다 — 한쪽만 쌓이면 사람이 알아야 한다', () => {
    const counts = summarizeOperatorExamples([
      { kind: 'operator_false_positive', labels: [] },
      { kind: 'operator_false_positive', labels: [] },
      { kind: 'operator_missed', labels: ['RUMOR'] },
    ]);
    expect(counts.operator_false_positive).toBe(2);
    expect(counts.operator_missed).toBe(1);
    expect(counts.total).toBe(3);
  });
});
