import { describe, expect, it } from 'vitest';
import type { Finding } from '../compliance';
import {
  calibrationExamples,
  classifyReview,
  summarizeAccuracy,
  type LabeledReview,
} from '../screeningAccuracy';

// 검수의 정답 라벨은 운영자의 결정에서만 나온다.
// 이 테스트는 "어떤 결정이 어떤 라벨이 되는가"를 고정한다 —
// 여기가 흔들리면 오탐률 수치가 의미를 잃고, 그 위에 올릴 모델 교체·차등 검수 판단도 무너진다.

function finding(over: Partial<Finding> = {}): Finding {
  return {
    category: 'UNSUPPORTED_CLAIM',
    severity: 'WARN',
    quote: '반드시 오른다',
    reason: '근거 없는 단정',
    source: 'ai',
    ...over,
  };
}

function review(over: Partial<LabeledReview> = {}): LabeledReview {
  return {
    decision: 'WARN',
    findings: [finding()],
    verdict: null,
    findingsValid: null,
    actualCategories: [],
    ...over,
  };
}

describe('classifyReview', () => {
  it('판정 전 건은 표본이 아니다', () => {
    expect(classifyReview(review())).toBe('UNLABELED');
  });

  it('보류 후 반려 = 정탐', () => {
    expect(classifyReview(review({ verdict: 'REJECTED' }))).toBe('TRUE_POSITIVE');
  });

  it('보류 후 승인 = 오탐 (기본값)', () => {
    expect(classifyReview(review({ verdict: 'APPROVED' }))).toBe('FALSE_POSITIVE');
  });

  it('승인이라도 "지적은 타당했음"이면 경미로 분리된다', () => {
    // 규칙을 지워야 한다(오탐)와 심각도를 낮춰야 한다(경미)는 처방이 다르다
    expect(classifyReview(review({ verdict: 'APPROVED', findingsValid: true }))).toBe('MINOR');
  });

  it('소견 없이 통과했다가 강제 철회되면 미탐', () => {
    // 미탐의 유일한 관측 경로 — 대기 건이 없으므로 최근 검수 기록에 라벨이 붙어야 잡힌다
    expect(classifyReview(review({ decision: 'PASS', findings: [], verdict: 'TAKEDOWN' }))).toBe(
      'FALSE_NEGATIVE',
    );
  });

  it('통과 건을 확인 후 유지하면 정상 통과', () => {
    expect(classifyReview(review({ decision: 'PASS', findings: [], verdict: 'KEPT' }))).toBe(
      'TRUE_NEGATIVE',
    );
  });

  it('AI 검수 실패로 보류된 건은 정확도 표본에서 뺀다', () => {
    // 판단 자체가 없었으므로 맞고 틀림을 따질 대상이 없다 (가용성 문제)
    expect(
      classifyReview(review({ decision: 'UNAVAILABLE', findings: [], verdict: 'APPROVED' })),
    ).toBe('UNLABELED');
  });
});

describe('summarizeAccuracy', () => {
  it('정탐률·오탐률은 보류 건만을 분모로 한다', () => {
    const s = summarizeAccuracy([
      review({ verdict: 'REJECTED' }),
      review({ verdict: 'REJECTED' }),
      review({ verdict: 'APPROVED' }),
      review({ verdict: 'APPROVED', findingsValid: true }),
      // 통과 후 철회 — 보류된 적이 없으므로 분모에 들어가지 않는다
      review({ decision: 'PASS', findings: [], verdict: 'TAKEDOWN' }),
    ]);
    expect(s.labeled).toBe(5);
    expect(s.held).toBe(4);
    expect(s.precision).toBe(0.5);
    expect(s.falsePositiveRate).toBe(0.25);
    expect(s.falseNegative).toBe(1);
  });

  it('반려된 건이라도 운영자가 다른 유형을 지목하면 그 소견은 오탐이다', () => {
    const s = summarizeAccuracy([
      review({
        findings: [finding({ category: 'RUMOR' }), finding({ category: 'UNSUPPORTED_CLAIM' })],
        verdict: 'REJECTED',
        actualCategories: ['RUMOR'],
      }),
    ]);
    const rumor = s.byCategory.find((c) => c.key === 'RUMOR');
    const claim = s.byCategory.find((c) => c.key === 'UNSUPPORTED_CLAIM');
    expect(rumor).toMatchObject({ confirmed: 1, falsePositive: 0 });
    expect(claim).toMatchObject({ confirmed: 0, falsePositive: 1 });
  });

  it('운영자가 지목했는데 소견에 없던 유형은 미탐 유형으로 센다', () => {
    const s = summarizeAccuracy([
      review({
        findings: [finding({ category: 'RUMOR' })],
        verdict: 'REJECTED',
        actualCategories: ['RUMOR', 'PRIVATE_INFO'],
      }),
    ]);
    expect(s.byCategory.find((c) => c.key === 'PRIVATE_INFO')?.missed).toBe(1);
  });

  it('오탐을 출처별로 나눈다 — 고칠 곳이 정규식인지 프롬프트인지', () => {
    const s = summarizeAccuracy([
      review({
        findings: [
          finding({ category: 'RISK_INDUCEMENT', source: 'rule' }),
          finding({ category: 'UNSUPPORTED_CLAIM', source: 'ai' }),
        ],
        verdict: 'APPROVED',
      }),
    ]);
    expect(s.bySource.find((x) => x.key === 'rule')?.falsePositive).toBe(1);
    expect(s.bySource.find((x) => x.key === 'ai')?.falsePositive).toBe(1);
  });
});

describe('calibrationExamples', () => {
  it('오탐 사례만, 규칙이 낸 것은 빼고 모은다', () => {
    const examples = calibrationExamples([
      review({
        findings: [
          finding({ quote: '실적 개선이 확실시된다', source: 'ai' }),
          finding({ category: 'RISK_INDUCEMENT', quote: '올인', source: 'rule' }),
        ],
        verdict: 'APPROVED',
        operatorReason: '통상적인 전망 표현',
      }),
      // 정탐 건은 되먹이지 않는다 (그건 잘 잡은 것이다)
      review({ verdict: 'REJECTED' }),
    ]);
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({
      category: 'UNSUPPORTED_CLAIM',
      quote: '실적 개선이 확실시된다',
      note: '통상적인 전망 표현',
    });
  });

  it('같은 유형·같은 인용문은 한 번만 넣는다', () => {
    const dup = review({ verdict: 'APPROVED' });
    expect(calibrationExamples([dup, dup, dup])).toHaveLength(1);
  });

  it('개수 상한을 지킨다 (프롬프트가 무한정 커지지 않게)', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      review({ findings: [finding({ quote: `사례 ${i}` })], verdict: 'APPROVED' }),
    );
    expect(calibrationExamples(rows, 5)).toHaveLength(5);
  });
});
