import { describe, expect, it } from 'vitest';
import type { Finding } from '../compliance';
import { NEW_RESEARCHER_JUDGED_CARDS, teacherAskRequirement } from '../teacherAskPolicy';

// 큐가 밀릴 때 **무엇을 반드시 물을 것인가** (18차 V-7).

const finding = (severity: 'BLOCK' | 'WARN'): Finding => ({
  category: 'PROFIT_GUARANTEE',
  severity,
  quote: '원금 보장',
  reason: '보장 표현',
  source: 'rule',
});

/** 이력이 충분한 리서처의 평범한 WARN 한 건 */
const settled = {
  findings: [finding('WARN')],
  judgedCardCount: 10,
  rejectionCount: 0,
};

describe('반드시 물어야 하는 건', () => {
  it('규칙이 명백한 위반으로 본 건 — 처분이 가장 무겁다', () => {
    expect(
      teacherAskRequirement({ ...settled, findings: [finding('BLOCK')] }).requirement,
    ).toBe('REQUIRED');
  });

  it('판정 이력이 없는 리서처 — 평판으로 거를 수 없는 유일한 구간', () => {
    for (let n = 0; n < NEW_RESEARCHER_JUDGED_CARDS; n++) {
      expect(teacherAskRequirement({ ...settled, judgedCardCount: n }).requirement, `${n}건`).toBe(
        'REQUIRED',
      );
    }
    expect(
      teacherAskRequirement({ ...settled, judgedCardCount: NEW_RESEARCHER_JUDGED_CARDS })
        .requirement,
    ).toBe('OPTIONAL');
  });

  it('반려를 반복하며 문구만 고쳐 오는 이력 — 규칙을 더듬는 중일 수 있다', () => {
    expect(teacherAskRequirement({ ...settled, rejectionCount: 3 }).requirement).toBe('REQUIRED');
    expect(teacherAskRequirement({ ...settled, rejectionCount: 2 }).requirement).toBe('OPTIONAL');
  });
});

describe('운영자 단독으로 처리해도 되는 건', () => {
  it('이력 있는 리서처의 WARN 한 건', () => {
    const out = teacherAskRequirement(settled);
    expect(out.requirement).toBe('OPTIONAL');
    // **안 물어보면 승인 쪽으로** — λ=4 아래에서 확인 없는 반려가 더 비싸다
    expect(out.reason).toContain('승인');
  });

  it('이유를 언제나 함께 준다 — 화면이 그대로 보여준다', () => {
    for (const input of [
      settled,
      { ...settled, findings: [finding('BLOCK')] },
      { ...settled, judgedCardCount: 0 },
      { ...settled, rejectionCount: 5 },
    ]) {
      expect(teacherAskRequirement(input).reason.length).toBeGreaterThan(0);
    }
  });
});
