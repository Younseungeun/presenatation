import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { fileRejectAppeal, getRejectAuditQueue, labelRejectReview, RejectAuditError } from '../rejectAuditService';
import { getDetectionLadder } from '../detectionLadderService';
import { APPEAL_MAX_OPEN } from '@/domain/rejectAppeal';

// 거절 훑기 · 이의 (B1, 2026-09-01) — 즉시 거절 기록에 사람 판정이 붙어 사다리에 BLOCK 규칙이 나타난다.

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createTestDb('rejectaudit');
});
afterAll(async () => {
  await prisma.$disconnect();
});

const STATEMENT = '이 문장은 면책 문구로 "보장하지 않는다"고 쓴 것이라 위반이 아닙니다';

async function seedResearcher() {
  const user = await prisma.user.create({ data: { email: `r${Math.random()}@t.io`, identityVerified: true, penName: '리서처' } });
  const researcher = await prisma.researcherProfile.create({ data: { userId: user.id } });
  return { user, researcher };
}
async function seedRejected(researcherId: string, rejectionCount = 0, ruleId = 'PROFIT_GUARANTEE') {
  const report = await prisma.report.create({
    data: { researcherId, title: '거절된 리포트', summary: 's', content: '원금 보장됩니다', priceKrw: 10_000, feeRateBp: 2_000, status: 'DRAFT', rejectionCount },
  });
  const review = await prisma.complianceReview.create({
    data: {
      reportId: report.id,
      decision: 'BLOCK',
      reviewer: 'rule',
      findingsJson: JSON.stringify([{ category: 'PROFIT_GUARANTEE', severity: 'BLOCK', quote: '원금 보장됩니다', reason: 'r', ruleId, source: 'rule' }]),
    },
  });
  return { report, review };
}

describe('거절 훑기 큐', () => {
  it('판정 없는 BLOCK 기록이 뜨고, 판정을 찍으면 큐에서 빠지며 사다리에 규칙 행이 생긴다', async () => {
    const { researcher } = await seedResearcher();
    const a = await seedRejected(researcher.id);
    const b = await seedRejected(researcher.id);
    const queue = await getRejectAuditQueue(prisma);
    expect(queue.map((q) => q.reviewId)).toEqual(expect.arrayContaining([a.review.id, b.review.id]));
    expect(queue.find((q) => q.reviewId === a.review.id)?.quotes).toContain('원금 보장됩니다');

    await labelRejectReview(prisma, { reviewId: a.review.id, verdict: 'TP', operatorUserId: 'op' });
    await labelRejectReview(prisma, { reviewId: b.review.id, verdict: 'FP', operatorUserId: 'op' });
    const after = await getRejectAuditQueue(prisma);
    expect(after.some((q) => q.reviewId === a.review.id || q.reviewId === b.review.id)).toBe(false);

    // 같은 잣대로 사다리에 들어간다 — 정탐 1 · 오탐 1
    const row = (await getDetectionLadder(prisma)).find((r) => r.id === 'PROFIT_GUARANTEE');
    expect(row).toBeDefined();
    expect(row!.truePos).toBeGreaterThanOrEqual(1);
    expect(row!.falsePos).toBeGreaterThanOrEqual(1);
    // 리포트 상태는 안 건드린다
    expect((await prisma.report.findUnique({ where: { id: b.report.id } }))?.status).toBe('DRAFT');
    // 이미 판정된 건은 다시 못 찍는다
    await expect(labelRejectReview(prisma, { reviewId: a.review.id, verdict: 'FP', operatorUserId: 'op' })).rejects.toBeInstanceOf(RejectAuditError);
  });
});

describe('거절 이의', () => {
  it('소명이 있으면 접수되고 큐 맨 앞에 서며, 오탐 판정이 나면 리서처에게 알린다', async () => {
    const { user, researcher } = await seedResearcher();
    const { report, review } = await seedRejected(researcher.id);
    const r = await fileRejectAppeal(prisma, { reportId: report.id, researcherId: researcher.id, statement: STATEMENT });
    expect(r.reviewId).toBe(review.id);
    const queue = await getRejectAuditQueue(prisma);
    expect(queue[0].reviewId).toBe(review.id);
    expect(queue[0].appealStatement).toBe(STATEMENT);

    await labelRejectReview(prisma, { reviewId: review.id, verdict: 'FP', operatorUserId: 'op' });
    const noti = await prisma.notification.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    expect(noti?.title).toContain('이의가 받아들여졌습니다');
  });

  it('거절 1건에 이의 1회 · 남의 리포트 불가 · 소명 짧으면 거부', async () => {
    const { researcher } = await seedResearcher();
    const other = await seedResearcher();
    const { report } = await seedRejected(researcher.id);
    await expect(fileRejectAppeal(prisma, { reportId: report.id, researcherId: researcher.id, statement: '억울합니다' })).rejects.toThrow(/자 이상/);
    await fileRejectAppeal(prisma, { reportId: report.id, researcherId: researcher.id, statement: STATEMENT });
    await expect(fileRejectAppeal(prisma, { reportId: report.id, researcherId: researcher.id, statement: STATEMENT })).rejects.toThrow(/1회/);
    await expect(fileRejectAppeal(prisma, { reportId: report.id, researcherId: other.researcher.id, statement: STATEMENT })).rejects.toBeInstanceOf(RejectAuditError);
  });

  it('미결 이의 상한 · 반려 누적 문턱이면 창구가 닫힌다', async () => {
    const { researcher } = await seedResearcher();
    for (let i = 0; i < APPEAL_MAX_OPEN; i++) {
      const { report } = await seedRejected(researcher.id);
      await fileRejectAppeal(prisma, { reportId: report.id, researcherId: researcher.id, statement: STATEMENT });
    }
    const extra = await seedRejected(researcher.id);
    await expect(fileRejectAppeal(prisma, { reportId: extra.report.id, researcherId: researcher.id, statement: STATEMENT })).rejects.toThrow(/기다리는 이의/);

    const closed = await seedResearcher();
    const { report } = await seedRejected(closed.researcher.id, 3);
    await expect(fileRejectAppeal(prisma, { reportId: report.id, researcherId: closed.researcher.id, statement: STATEMENT })).rejects.toThrow(/운영자가 직접 검토/);
  });
});
