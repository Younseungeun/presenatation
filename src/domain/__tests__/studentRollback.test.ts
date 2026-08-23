import { describe, expect, it } from 'vitest';
import type { Finding } from '../compliance';
import type { LabeledReview } from '../screeningAccuracy';
import {
  ROLLBACK_COST_RATIO,
  ROLLBACK_WINDOW,
  studentRollbackStatus,
} from '../studentRollback';

// 롤백 판단이 지켜야 하는 것 (9차 G-4).
//
// 이 장치가 답하는 질문은 하나다: **켠 뒤에 무엇을 보고 끄는가.**
// 잘못 만들면 두 가지로 실패한다 — 오탐 한 건에 놀라 껐다 켰다 하거나,
// 계속 나빠지는데 아무도 눈치채지 못하거나.

function finding(source: Finding['source']): Finding {
  return {
    category: 'PRIVATE_INFO',
    severity: 'WARN',
    quote: '',
    reason: '테스트',
    source,
  };
}

function review(over: Partial<LabeledReview> = {}): LabeledReview {
  return {
    decision: 'WARN',
    findings: [finding('student')],
    verdict: 'REJECTED', // 기본은 정탐
    findingsValid: null,
    actualCategories: [],
    ...over,
  };
}

/** 학생이 정탐한 건 */
const hit = () => review({ verdict: 'REJECTED' });
/** 학생이 오탐한 건 (보류 → 승인, 지적도 타당하지 않았다) */
const miss = () => review({ verdict: 'APPROVED', findingsValid: false });

describe('studentRollbackStatus', () => {
  it('표본이 창의 절반에 못 미치면 판단하지 않는다', () => {
    const r = studentRollbackStatus([miss(), miss(), miss()]);
    expect(r.shouldRollback).toBe(false);
    expect(r.summary).toContain('표본 부족');
  });

  it('오탐 몇 건으로는 끄지 않는다 — 잡은 것이 그보다 크면 순이익이 양수다', () => {
    // 정탐 30 + 오탐 5 → 30 − 4×5 = +10
    const rows = [...Array(30)].map(hit).concat([...Array(5)].map(miss));
    const r = studentRollbackStatus(rows);
    expect(r.netValue).toBe(30 - ROLLBACK_COST_RATIO * 5);
    expect(r.shouldRollback).toBe(false);
  });

  it('오탐이 비용을 넘으면 끈다', () => {
    // 정탐 10 + 오탐 15 → 10 − 60 = −50
    const rows = [...Array(10)].map(hit).concat([...Array(15)].map(miss));
    const r = studentRollbackStatus(rows);
    expect(r.netValue).toBeLessThan(0);
    expect(r.shouldRollback).toBe(true);
  });

  it('**학생이 말하지 않은 건은 학생의 성적이 아니다** — 규칙 오탐으로 학생이 꺼지면 안 된다', () => {
    // 규칙만 낸 소견으로 승인(=규칙의 오탐)이 30건 있어도 학생과 무관하다
    const ruleOnly = [...Array(30)].map(() =>
      review({ findings: [finding('rule')], verdict: 'APPROVED', findingsValid: false }),
    );
    const r = studentRollbackStatus(ruleOnly);
    expect(r.scored).toBe(0);
    expect(r.shouldRollback).toBe(false);
  });

  it('"지적은 타당했다"(경미)는 오탐으로 세지 않는다', () => {
    const rows = [...Array(30)].map(() =>
      review({ verdict: 'APPROVED', findingsValid: true }),
    );
    const r = studentRollbackStatus(rows);
    expect(r.falsePositives).toBe(0);
    expect(r.caught).toBe(30);
  });

  it('라벨이 없는 건은 분모에서 빠진다', () => {
    const rows = [...Array(30)].map(() => review({ verdict: null }));
    const r = studentRollbackStatus(rows);
    expect(r.scored).toBe(0);
  });

  it('창 밖의 옛 기록은 보지 않는다 — 지금 상태를 재는 장치다', () => {
    // 최신 25건은 전부 정탐, 그 뒤로 옛 오탐이 100건 있어도 창 안만 본다
    const rows = [...Array(ROLLBACK_WINDOW)].map(hit).concat([...Array(100)].map(miss));
    const r = studentRollbackStatus(rows);
    expect(r.falsePositives).toBe(0);
    expect(r.shouldRollback).toBe(false);
  });
});
