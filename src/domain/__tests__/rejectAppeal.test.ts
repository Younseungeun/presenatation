import { describe, expect, it } from 'vitest';
import {
  APPEAL_CLOSED_AT_REJECTIONS,
  APPEAL_MAX_OPEN,
  APPEAL_MIN_STATEMENT,
  checkAppealAllowed,
  REJECT_AUDIT_SAMPLE_PER_RULE,
  sampleRejectAudit,
} from '../rejectAppeal';

// 거절 훑기 표본 · 이의 상한 (B1, 2026-09-01) — 상한 셋이 이진 탐색 통로를 막고, 표본이 전수를 대신한다.

const ok = {
  alreadyAppealed: false,
  alreadyAudited: false,
  openAppeals: 0,
  rejectionCount: 0,
  statement: '이 문장은 면책 문구로 "보장하지 않는다"고 쓴 것이라 위반이 아닙니다',
};

describe('checkAppealAllowed', () => {
  it('정상 소명은 통과', () => {
    expect(checkAppealAllowed(ok)).toEqual({ ok: true });
  });
  it('거절 1건에 이의 1회', () => {
    expect(checkAppealAllowed({ ...ok, alreadyAppealed: true })).toMatchObject({ ok: false, reason: 'ALREADY_APPEALED' });
  });
  it('운영자가 이미 확인한 거절엔 못 낸다', () => {
    expect(checkAppealAllowed({ ...ok, alreadyAudited: true })).toMatchObject({ ok: false, reason: 'ALREADY_AUDITED' });
  });
  it('미결 이의 상한', () => {
    expect(checkAppealAllowed({ ...ok, openAppeals: APPEAL_MAX_OPEN })).toMatchObject({ ok: false, reason: 'TOO_MANY_OPEN' });
    expect(checkAppealAllowed({ ...ok, openAppeals: APPEAL_MAX_OPEN - 1 })).toEqual({ ok: true });
  });
  it('반려 누적이 문턱이면 창구가 닫힌다 — 이미 사람 검토로 넘어간 리서처', () => {
    expect(checkAppealAllowed({ ...ok, rejectionCount: APPEAL_CLOSED_AT_REJECTIONS })).toMatchObject({ ok: false, reason: 'CLOSED_BY_REJECTIONS' });
  });
  it('소명 하한 — 한 낱말로는 안 된다', () => {
    expect(checkAppealAllowed({ ...ok, statement: '억울합니다' })).toMatchObject({ ok: false, reason: 'TOO_SHORT' });
    expect(checkAppealAllowed({ ...ok, statement: 'x'.repeat(APPEAL_MIN_STATEMENT) })).toEqual({ ok: true });
  });
});

describe('sampleRejectAudit', () => {
  const d = (i: number) => new Date(Date.UTC(2026, 8, 1, i));
  it('이의 건은 전부 맨 앞, 그 다음 규칙별 최근 N건, 같은 건은 한 번', () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ({ reviewId: `a${i}`, ruleIds: ['PROFIT_GUARANTEE'], appealed: false, createdAt: d(i) })),
      { reviewId: 'x', ruleIds: ['PROFIT_GUARANTEE'], appealed: true, createdAt: d(0) },
      { reviewId: 'y', ruleIds: ['CONTACT_SHAPE', 'PROFIT_GUARANTEE'], appealed: false, createdAt: d(20) },
    ];
    const out = sampleRejectAudit(items);
    expect(out[0].reviewId).toBe('x'); // 이의는 오래됐어도 맨 앞
    // 규칙별 표본: PROFIT_GUARANTEE 5건(y 포함) — y 가 최신이라 먼저
    const pg = out.filter((o) => o.ruleIds.includes('PROFIT_GUARANTEE') && !o.appealed);
    expect(pg).toHaveLength(REJECT_AUDIT_SAMPLE_PER_RULE);
    expect(pg[0].reviewId).toBe('y');
    expect(new Set(out.map((o) => o.reviewId)).size).toBe(out.length);
  });
  it('규칙마다 따로 센다 — 한 규칙이 많아도 다른 규칙의 표본을 밀어내지 않는다', () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => ({ reviewId: `p${i}`, ruleIds: ['PROFIT_GUARANTEE'], appealed: false, createdAt: d(i) })),
      { reviewId: 'c1', ruleIds: ['CONTACT_SHAPE'], appealed: false, createdAt: d(0) },
    ];
    const out = sampleRejectAudit(items);
    expect(out.some((o) => o.reviewId === 'c1')).toBe(true);
    expect(out.filter((o) => o.ruleIds.includes('PROFIT_GUARANTEE'))).toHaveLength(REJECT_AUDIT_SAMPLE_PER_RULE);
  });
});
