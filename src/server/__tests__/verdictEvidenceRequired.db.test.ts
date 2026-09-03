import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { ComplianceVerdictError, operatorVerdictWrites } from '../complianceService';

// **ARGOS 만 잡았거나 아무도 못 잡은 건을 위반으로 확정할 때는 근거 문장이 필수다** (2026-09-01).
// ARGOS 소견은 문장을 짚지 못하므로, 여기서 안 짚으면 "ARGOS 유형별 문장 모음"(졸업 강등 본선
// 재료)이 영원히 안 쌓인다. 규칙·사전이 소견을 낸 건은 소견이 문장을 짚고 있어 종전대로 선택.

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createTestDb('verdictevidence');
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedReview(findings: unknown[]) {
  const user = await prisma.user.create({ data: { email: `r${Math.random()}@t.io`, identityVerified: true } });
  const researcher = await prisma.researcherProfile.create({ data: { userId: user.id } });
  const report = await prisma.report.create({
    data: {
      researcherId: researcher.id,
      title: 't',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      feeRateBp: 2_000,
      status: 'PENDING_REVIEW',
    },
  });
  await prisma.complianceReview.create({
    data: { reportId: report.id, decision: 'WARN', reviewer: 'rule', findingsJson: JSON.stringify(findings), needsOperatorReview: true },
  });
  return report.id;
}

const student = { category: 'SOLICIT_CONTACT', severity: 'WARN', quote: '', reason: 'r', source: 'student' };
const rule = { category: 'SOLICIT_CONTACT', severity: 'WARN', quote: 'q', reason: 'r', ruleId: 'X', source: 'rule' };
const now = new Date();

describe('근거 문장 필수 관문', () => {
  it('ARGOS 만 잡은 건을 근거 없이 반려하면 거절한다 — 짚으면 통과', async () => {
    const reportId = await seedReview([student]);
    await expect(operatorVerdictWrites(prisma, reportId, 'REJECTED', 'op', now, {})).rejects.toBeInstanceOf(
      ComplianceVerdictError,
    );
    await expect(operatorVerdictWrites(prisma, reportId, 'REJECTED', 'op', now, { evidence: ['디엠 주세요'] })).resolves.toBeInstanceOf(Array);
  });

  it('강제 철회·신고 확인(TAKEDOWN·MISSED)도 같다 — 아무도 못 잡은 미탐은 가장 귀한 재료다 (2026-09-01 확정)', async () => {
    const reportId = await seedReview([]);
    await expect(operatorVerdictWrites(prisma, reportId, 'TAKEDOWN', 'op', now, {})).rejects.toBeInstanceOf(
      ComplianceVerdictError,
    );
    await expect(operatorVerdictWrites(prisma, reportId, 'TAKEDOWN', 'op', now, { evidence: ['노란 앱으로 오세요'] })).resolves.toBeInstanceOf(Array);
    const reportId2 = await seedReview([]);
    await expect(operatorVerdictWrites(prisma, reportId2, 'MISSED', 'op', now, {})).rejects.toBeInstanceOf(
      ComplianceVerdictError,
    );
  });

  it('규칙이 소견을 낸 건은 종전대로 선택이다 — 근거 없이도 반려된다', async () => {
    const reportId = await seedReview([student, rule]);
    await expect(operatorVerdictWrites(prisma, reportId, 'REJECTED', 'op', now, {})).resolves.toBeInstanceOf(Array);
  });

  it('승인(오탐·경미)에는 요구하지 않는다 — 확정 위반이 아니라 재료가 아니다', async () => {
    const reportId = await seedReview([student]);
    await expect(operatorVerdictWrites(prisma, reportId, 'APPROVED', 'op', now, { findingsValid: false })).resolves.toBeInstanceOf(Array);
  });
});
