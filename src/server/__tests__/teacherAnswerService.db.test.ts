import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { teacherPackId } from '@/domain/teacherAnswer';
import type { StudentLabel } from '@/domain/studentText';
import type { RiskCategory } from '@/domain/compliance';
import {
  disagrees,
  getTeacherCorrections,
  recordTeacherAnswer,
  TeacherAnswerError,
} from '../teacherAnswerService';
import { getTeacherAnswerPending, getTeacherAskCoverage } from '../teacherAnswerQueue';

// **순서가 이 표의 값어치 전부다** (18차 V-3).
//
// 자동 2차에서는 교사와 운영자가 독립이었다. 사람이 나르면 운영자가 교사 답을 **보고**
// 고르게 되고, 그 순간 두 값이 같은 출처가 된다 — 정확도 지표가 자기 자신을 재게 된다.
// 검토의 결론: *"독립성은 코드 구조가 아니라 작업자의 클릭 순서에서 나온다."*
// 화면 안내로는 부족하다. 안내는 지켜지지 않고, 지켜지지 않은 것은 기록에 남지 않는다.

let prisma: PrismaClient;

async function seedReview(
  verdict: string | null,
  opts: { categories?: string[]; findingsValid?: boolean | null; quote?: string } = {},
) {
  const user = await prisma.user.create({
    data: { email: `r${Math.random()}@t.io`, identityVerified: true },
  });
  const researcher = await prisma.researcherProfile.create({ data: { userId: user.id } });
  const report = await prisma.report.create({
    data: {
      researcherId: researcher.id,
      title: '분석',
      summary: '요약',
      content: '본문',
      priceKrw: 10_000,
      feeRateBp: 2_000,
      status: 'PENDING_REVIEW',
    },
  });
  const review = await prisma.complianceReview.create({
    data: {
      reportId: report.id,
      decision: 'WARN',
      reviewer: 'rule',
      needsOperatorReview: true,
      findingsJson: JSON.stringify([
        {
          category: 'PROFIT_GUARANTEE',
          severity: 'WARN',
          quote: opts.quote ?? '원금은 지켜 드립니다',
          reason: '보장 표현',
          source: 'rule',
        },
      ]),
      operatorVerdict: verdict,
      operatorReviewedAt: verdict ? new Date() : null,
      operatorReviewedBy: verdict ? 'op-1' : null,
      operatorReason: verdict ? '보장 표현이 있습니다' : null,
      operatorCategories: opts.categories ? JSON.stringify(opts.categories) : null,
      aiFindingsValid: opts.findingsValid ?? null,
      teacherAskedAt: new Date(),
    },
  });
  return review.id;
}

const answer = (id: string, labels: string[], validity?: '타당' | '과함') =>
  `{"id":"${teacherPackId(id)}","labels":${JSON.stringify(labels)}}` +
  (validity ? `\n지적: ${validity}` : '');

beforeAll(async () => {
  prisma = createTestDb('teacher-answer-');
  await seedTestInstruments(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('순서 강제 (18차 V-3)', () => {
  it('**운영자 판정이 없으면 거절한다** — 답을 보고 고르면 두 값이 독립이 아니다', async () => {
    const id = await seedReview(null);
    await expect(
      recordTeacherAnswer(prisma, {
        reviewId: id,
        text: answer(id, ['PROFIT_GUARANTEE']),
        teacherTag: 't',
        operatorUserId: 'op-1',
      }),
    ).rejects.toThrow(TeacherAnswerError);
    expect(await prisma.teacherAnswer.count({ where: { complianceReviewId: id } })).toBe(0);
  });

  it('결정이 있으면 기록하고, 두 값을 **따로** 남긴다', async () => {
    const id = await seedReview('REJECTED', { categories: ['PROFIT_GUARANTEE'] });
    const out = await recordTeacherAnswer(prisma, {
      reviewId: id,
      text: answer(id, ['PROFIT_GUARANTEE']),
      teacherTag: 'teacher-x',
      operatorUserId: 'op-1',
    });
    expect(out.disagreed).toBe(false);

    const row = await prisma.teacherAnswer.findUnique({ where: { complianceReviewId: id } });
    expect(row?.teacherTag).toBe('teacher-x');
    // 운영자 값은 건드리지 않는다 — 정확도 지표는 여전히 사람의 결정으로 잰다
    const review = await prisma.complianceReview.findUnique({ where: { id } });
    expect(review?.operatorCategories).toBe(JSON.stringify(['PROFIT_GUARANTEE']));
  });

  it('못 읽는 답은 기록하지 않는다 — 지어낸 라벨이 그대로 학습 자료가 된다', async () => {
    const id = await seedReview('APPROVED', { findingsValid: false });
    await expect(
      recordTeacherAnswer(prisma, {
        reviewId: id,
        text: '괜찮아 보입니다',
        teacherTag: 't',
        operatorUserId: 'op-1',
      }),
    ).rejects.toThrow(/JSON/);
    expect(await prisma.teacherAnswer.count({ where: { complianceReviewId: id } })).toBe(0);
  });

  it('두 번 물어보면 마지막 답이 남는다 (답이 애매했을 때 다시 묻는다)', async () => {
    const id = await seedReview('APPROVED', { findingsValid: true });
    for (const v of ['과함', '타당'] as const) {
      await recordTeacherAnswer(prisma, {
        reviewId: id,
        text: answer(id, [], v),
        teacherTag: 't',
        operatorUserId: 'op-1',
      });
    }
    const rows = await prisma.teacherAnswer.findMany({ where: { complianceReviewId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].findingsValid).toBe(true);
  });
});

describe('불일치 판정 — 결론 수준에서 본다', () => {
  const t = (labels: string[], findingsValid: boolean | null = null) => ({
    labels: labels as StudentLabel[],
    findingsValid,
    note: '',
  });
  const op = (verdict: string, categories: string[], findingsValid: boolean | null = null) => ({
    verdict,
    categories: categories as RiskCategory[],
    findingsValid,
  });

  it('위반이냐 아니냐가 갈리면 불일치', () => {
    expect(disagrees(t([]), op('REJECTED', ['RUMOR']))).toBe(true);
    expect(disagrees(t(['RUMOR']), op('APPROVED', [], false))).toBe(true);
  });

  it('둘 다 위반이면 **유형이 하나도 안 겹칠 때만** 불일치', () => {
    const rejected = op('REJECTED', ['RUMOR', 'PRIVATE_INFO']);
    // 이름을 몇 개 더 붙였는지는 결론이 아니다 — 하나만 겹쳐도 같은 것을 보고 있다
    expect(disagrees(t(['RUMOR', 'UNSUPPORTED_CLAIM']), rejected)).toBe(false);
    expect(disagrees(t(['SOLICIT_CONTACT']), rejected)).toBe(true);
  });

  it('둘 다 위반 없음이면 오탐이냐 경미냐가 갈리는지 본다', () => {
    expect(disagrees(t([], false), op('APPROVED', [], true))).toBe(true);
    expect(disagrees(t([], true), op('APPROVED', [], true))).toBe(false);
    // 운영자가 아무 표시 없이 승인했으면 대조할 값이 없다 — 없는 불일치를 지어내지 않는다
    expect(disagrees(t([], false), op('APPROVED', [], null))).toBe(false);
  });
});

describe('교정 사례 — 틀린 것을 사람이 고친 기록만 (18차 V-5)', () => {
  it('일치한 건은 사례가 되지 않는다 — 맞힌 것을 다시 먹이는 것은 의미가 없다', async () => {
    const id = await seedReview('REJECTED', {
      categories: ['PROFIT_GUARANTEE'],
      quote: '일치한 건입니다',
    });
    await recordTeacherAnswer(prisma, {
      reviewId: id,
      text: answer(id, ['PROFIT_GUARANTEE']),
      teacherTag: 't',
      operatorUserId: 'op-1',
    });
    const out = await getTeacherCorrections(prisma);
    expect(out.map((c) => c.quote)).not.toContain('일치한 건입니다');
  });

  it('교사가 놓친 것을 사람이 잡았으면 **미탐 사례**로 나간다', async () => {
    const id = await seedReview('REJECTED', {
      categories: ['PROFIT_GUARANTEE'],
      quote: '교사가 놓친 문장',
    });
    await recordTeacherAnswer(prisma, {
      reviewId: id,
      text: answer(id, [], '과함'),
      teacherTag: 't',
      operatorUserId: 'op-1',
    });
    const out = await getTeacherCorrections(prisma);
    const hit = out.find((c) => c.quote === '교사가 놓친 문장');
    expect(hit?.kind).toBe('miss');
    expect(hit?.category).toBe('PROFIT_GUARANTEE');
  });

  it('교사가 잘못 잡은 것을 사람이 풀었으면 **오탐 사례**로 나간다', async () => {
    const id = await seedReview('APPROVED', {
      findingsValid: false,
      quote: '교사가 잘못 잡은 문장',
    });
    await recordTeacherAnswer(prisma, {
      reviewId: id,
      text: answer(id, ['RUMOR']),
      teacherTag: 't',
      operatorUserId: 'op-1',
    });
    const out = await getTeacherCorrections(prisma);
    const hit = out.find((c) => c.quote === '교사가 잘못 잡은 문장');
    expect(hit?.kind).toBe('falsePositive');
    expect(hit?.category).toBe('RUMOR');
  });

  it('기본 상한은 4건 — 사람이 복사하는 문서라 길이가 곧 부담이다', async () => {
    for (let i = 0; i < 8; i++) {
      const id = await seedReview('REJECTED', {
        categories: ['RUMOR'],
        quote: `상한 시험 ${i}`,
      });
      await recordTeacherAnswer(prisma, {
        reviewId: id,
        text: answer(id, [], '과함'),
        teacherTag: 't',
        operatorUserId: 'op-1',
      });
    }
    expect((await getTeacherCorrections(prisma)).length).toBeLessThanOrEqual(4);
  });
});

describe('질의 실태 계측 (18차 V-7)', () => {
  // 이 시험만 스위트 중간에 **두 번째 DB를 새로 만든다** (createTestDb + 시드) —
  // 전체 실행의 디스크 경합 아래에서 기본 5초가 간헐적으로 모자랐다 (2026-08-21
  // 재현: 전체 실행 2/4회 타임아웃, 단독 실행 항상 통과). 재는 것은 속도가 아니라
  // 집계의 정확성이므로 시간을 넉넉히 준다
  it('안 물어보고 내린 결정이 숫자로 남는다 — 이 고장은 조용히 일어난다', { timeout: 30_000 }, async () => {
    const prisma2 = createTestDb('teacher-coverage-');
    try {
      await seedTestInstruments(prisma2);
      const saved = prisma;
      prisma = prisma2;
      const asked = await seedReview('APPROVED', { findingsValid: true });
      const notAsked = await seedReview('APPROVED', { findingsValid: true });
      prisma = saved;
      await prisma2.complianceReview.update({
        where: { id: notAsked },
        data: { teacherAskedAt: null },
      });

      const cov = await getTeacherAskCoverage(prisma2);
      expect(cov.decided).toBe(2);
      expect(cov.asked).toBe(1); // 하나는 물어보지 않고 결정했다
      expect(cov.answered).toBe(0);

      // 답 대기 줄에는 **물어본 건만** 선다 — 안 물어본 건까지 세우면 줄이 안 줄고,
      // 줄어들지 않는 큐는 곧 아무도 안 보는 큐가 된다
      const pending = await getTeacherAnswerPending(prisma2);
      expect(pending.map((p) => p.reviewId)).toEqual([asked]);
    } finally {
      await prisma2.$disconnect();
    }
  });
});
