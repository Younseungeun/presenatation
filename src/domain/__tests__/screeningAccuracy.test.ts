import { describe, expect, it } from 'vitest';
import type { Finding, RiskCategory } from '../compliance';
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

  it('**경미는 정탐과 갈라 담는다** — 처방이 다르므로 유형도 따로 보여야 한다', () => {
    const s = summarizeAccuracy([
      // 반려까지 간 인정 = 정탐
      review({ findings: [finding({ category: 'RUMOR' })], verdict: 'REJECTED' }),
      // 인정했지만 승인 = 경미 (심각도만 과했다)
      review({
        findings: [finding({ category: 'RUMOR' })],
        verdict: 'APPROVED',
        findingsValid: true,
      }),
    ]);
    const rumor = s.byCategory.find((c) => c.key === 'RUMOR');
    // 예전에는 둘 다 confirmed 2 로 뭉쳐 있었다 — 그러면 화면이 `정탐 1건 (RUMOR 2건)`을
    // 그리게 되고, 경미가 어느 유형에서 나는지는 영영 안 보인다
    expect(rumor).toMatchObject({ confirmed: 1, minor: 1, falsePositive: 0 });
    expect(s.truePositive).toBe(1);
    expect(s.minor).toBe(1);
  });

  it('경미로 담긴 소견은 오탐으로 세지 않는다 — 지적 자체는 맞았다', () => {
    const s = summarizeAccuracy([
      review({
        findings: [finding({ category: 'PROFIT_GUARANTEE' })],
        verdict: 'APPROVED',
        findingsValid: true,
      }),
    ]);
    const g = s.byCategory.find((c) => c.key === 'PROFIT_GUARANTEE');
    expect(g).toMatchObject({ minor: 1, falsePositive: 0, confirmed: 0 });
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

  // ── 놓친 사례도 되먹인다 (2026-08-21) ────────────────────────────
  // 오탐만 돌아가면 AI는 "너무 깐깐했다"만 배운다. 되먹임이 한쪽으로만 열려 있으면
  // 쓸수록 덜 잡는 쪽으로 기운다 — 그건 의도한 균형이어야지 파이프의 결과면 안 된다.

  const missed = (phrase: string | null, category: RiskCategory = 'SOLICIT_CONTACT') =>
    review({
      findings: [], // 미탐은 검수가 아무것도 안 짚었다
      verdict: 'MISSED',
      actualCategories: [category],
      missedPhrase: phrase,
      operatorReason: '오픈채팅 유도로 확인',
    });

  it('미탐은 운영자가 등록한 표현을 인용문 자리에 쓴다', () => {
    const out = calibrationExamples([missed('오픈채팅방에서 안내')]);
    expect(out).toEqual([
      {
        kind: 'miss',
        category: 'SOLICIT_CONTACT',
        quote: '오픈채팅방에서 안내',
        note: '오픈채팅 유도로 확인',
      },
    ]);
  });

  it('등록한 표현이 없는 미탐은 건너뛴다 — 가르칠 구체물이 없다', () => {
    // 유형만 알려주는 예시는 아무것도 못 가르치면서 자리만 차지한다
    expect(calibrationExamples([missed(null)])).toHaveLength(0);
  });

  it('강제 철회(TAKEDOWN)도 같은 미탐으로 센다 — 내렸든 못 내렸든 놓친 것은 같다', () => {
    const takedown = { ...missed('리딩방에서 종목 안내'), verdict: 'TAKEDOWN' as const };
    expect(calibrationExamples([takedown])[0]).toMatchObject({ kind: 'miss' });
  });

  it('오탐이 아무리 많아도 미탐 자리는 남는다', () => {
    // 한 배열에 섞어 담고 앞에서 자르면, 최근 건이 한 종류로 몰린 날
    // 반대쪽이 통째로 사라진다
    const fps = Array.from({ length: 20 }, (_, i) =>
      review({ findings: [finding({ quote: `오탐 ${i}` })], verdict: 'APPROVED' }),
    );
    const out = calibrationExamples([...fps, missed('오픈채팅방에서 안내')], 8);
    expect(out).toHaveLength(8);
    expect(out.filter((e) => e.kind === 'miss')).toHaveLength(1);
    expect(out.filter((e) => e.kind === 'falsePositive')).toHaveLength(7);
  });
});

/**
 * **판단 시간이 없는 건을 줄마다 센다** (2026-08-24 창업자 지시).
 *
 * 정확도 표의 각 줄 옆에 칩으로 뜬다. 뭉쳐 적으면 "어느 줄이 얼마나 비어 있나"에
 * 답할 수 없는데, 그 답이 곧 **그 줄의 숫자를 얼마나 믿을 수 있나**이다 —
 * 판단 시간이 없는 건은 피로도 표의 분모에서도 빠지고 학습의 3초 필터도 못 본다.
 */
describe('판단 시간 공백을 판정 종류별로 가른다', () => {
  const START = Date.UTC(2026, 7, 22);
  const before = START - 86_400_000;
  const after = START + 86_400_000;

  it('측정 전 판정은 `beforeMeasureStart` — 잴 장치가 없던 때다', () => {
    const s = summarizeAccuracy(
      [review({ verdict: 'REJECTED', reviewedAt: before, elapsedMs: null })],
      { measureStartMs: START },
    );
    expect(s.noElapsed.truePositive).toEqual({ beforeMeasureStart: 1, offQueue: 0 });
  });

  it('측정 후인데 비어 있으면 `offQueue` — 큐 밖 경로로 들어왔다', () => {
    const s = summarizeAccuracy(
      [review({ verdict: 'APPROVED', reviewedAt: after, elapsedMs: null })],
      { measureStartMs: START },
    );
    expect(s.noElapsed.falsePositive).toEqual({ beforeMeasureStart: 0, offQueue: 1 });
  });

  it('**줄마다 따로 쌓인다** — 오탐의 공백이 정탐 줄에 섞이면 칩이 거짓말을 한다', () => {
    const s = summarizeAccuracy(
      [
        review({ verdict: 'REJECTED', reviewedAt: before, elapsedMs: null }), // 정탐
        review({ verdict: 'APPROVED', reviewedAt: after, elapsedMs: null }), // 오탐
        review({ verdict: 'APPROVED', findingsValid: true, reviewedAt: after, elapsedMs: null }), // 경미
      ],
      { measureStartMs: START },
    );
    expect(s.noElapsed.truePositive.beforeMeasureStart).toBe(1);
    expect(s.noElapsed.falsePositive.offQueue).toBe(1);
    expect(s.noElapsed.minor.offQueue).toBe(1);
    // 서로 넘어가지 않았다
    expect(s.noElapsed.truePositive.offQueue).toBe(0);
    expect(s.noElapsed.falseNegative).toEqual({ beforeMeasureStart: 0, offQueue: 0 });
  });

  it('시간이 있으면 어느 칸에도 안 센다', () => {
    const s = summarizeAccuracy(
      [review({ verdict: 'APPROVED', reviewedAt: after, elapsedMs: 12_000 })],
      { measureStartMs: START },
    );
    expect(s.noElapsed.falsePositive).toEqual({ beforeMeasureStart: 0, offQueue: 0 });
  });

  it('**측정 시작일을 안 주면 전부 `offQueue`** — 조용히 "괜찮다"고 답하지 않는다', () => {
    const s = summarizeAccuracy([
      review({ verdict: 'APPROVED', reviewedAt: before, elapsedMs: null }),
    ]);
    expect(s.noElapsed.falsePositive).toEqual({ beforeMeasureStart: 0, offQueue: 1 });
  });

  it('판정이 없는 건은 세지 않는다 — 표본 자체가 아니다', () => {
    const s = summarizeAccuracy([review({ verdict: null, reviewedAt: after, elapsedMs: null })], {
      measureStartMs: START,
    });
    expect(s.labeled).toBe(0);
    expect(s.noElapsed.falsePositive).toEqual({ beforeMeasureStart: 0, offQueue: 0 });
  });
});
