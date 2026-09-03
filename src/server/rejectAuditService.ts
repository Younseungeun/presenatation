import type { PrismaClient } from '@prisma/client';
import type { Finding } from '@/domain/compliance';
import { checkAppealAllowed, sampleRejectAudit } from '@/domain/rejectAppeal';
import { notifyOperators } from './opsAlert';

// 거절 훑기 큐 · 거절 이의 (B1, 2026-09-01). 규칙은 domain/rejectAppeal(순수).
//
// 즉시 거절(BLOCK)의 검수 기록에 **사람 판정을 붙이는** 두 통로. 판정이 붙는 순간 그 기록은
// 사다리 집계(getDetectionLadder — operatorVerdict 가 있는 기록만)에 들어가 BLOCK 규칙의
// 정탐/오탐이 처음으로 잡힌다. 판정 값은 큐의 반려 판정과 **같은 잣대**를 쓴다:
//   정탐(거절이 맞았다) = REJECTED · 오탐(잘못 거절했다) = APPROVED + aiFindingsValid=false
// 리포트 상태는 건드리지 않는다 — 이미 초안이고, 오탐이면 리서처가 그대로 다시 제출한다.

export class RejectAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectAuditError';
  }
}

export interface RejectAuditItem {
  reviewId: string;
  reportId: string;
  title: string;
  researcher: string | null;
  ruleIds: string[];
  quotes: string[];
  appealStatement: string | null;
  appealAt: Date | null;
  createdAt: Date;
}

function blockFindings(findingsJson: string): Finding[] {
  try {
    return (JSON.parse(findingsJson) as Finding[]).filter((f) => f.severity === 'BLOCK');
  } catch {
    return [];
  }
}

/** 판정 없는 BLOCK 기록 — 이의 건 전부 + 규칙별 최근 N건 표본 */
export async function getRejectAuditQueue(prisma: PrismaClient): Promise<RejectAuditItem[]> {
  const rows = await prisma.complianceReview.findMany({
    where: { decision: 'BLOCK', operatorVerdict: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      reportId: true,
      findingsJson: true,
      appealStatement: true,
      appealAt: true,
      createdAt: true,
      report: { select: { title: true, researcher: { select: { user: { select: { penName: true } } } } } },
    },
  });
  const candidates = rows.map((r) => {
    const blocks = blockFindings(r.findingsJson);
    return {
      reviewId: r.id,
      reportId: r.reportId,
      title: r.report.title,
      researcher: r.report.researcher.user.penName ?? null,
      ruleIds: [...new Set(blocks.map((f) => f.ruleId).filter((x): x is string => !!x))],
      quotes: blocks.map((f) => f.quote).filter((q) => !!q),
      appealStatement: r.appealStatement,
      appealAt: r.appealAt,
      appealed: r.appealAt !== null,
      createdAt: r.createdAt,
    };
  });
  return sampleRejectAudit(candidates).map(({ appealed: _a, ...item }) => item);
}

/** 운영자 판정 — 정탐/오탐. 오탐이면 이의를 낸 리서처에게 알린다(그대로 다시 제출하면 된다) */
export async function labelRejectReview(
  prisma: PrismaClient,
  input: { reviewId: string; verdict: 'TP' | 'FP'; operatorUserId: string },
  now = new Date(),
): Promise<void> {
  const review = await prisma.complianceReview.findUnique({
    where: { id: input.reviewId },
    select: {
      id: true,
      decision: true,
      operatorVerdict: true,
      appealAt: true,
      report: { select: { id: true, title: true, researcherId: true, researcher: { select: { userId: true } } } },
    },
  });
  if (!review || review.decision !== 'BLOCK') throw new RejectAuditError('즉시 거절 기록이 아닙니다');
  if (review.operatorVerdict) throw new RejectAuditError('이미 판정된 거절입니다');

  const writes = [
    prisma.complianceReview.update({
      where: { id: review.id },
      data: {
        operatorReviewedAt: now,
        operatorReviewedBy: input.operatorUserId,
        operatorVerdict: input.verdict === 'TP' ? 'REJECTED' : 'APPROVED',
        aiFindingsValid: input.verdict === 'TP' ? null : false,
      },
    }),
  ];
  if (input.verdict === 'FP' && review.appealAt) {
    writes.push(
      prisma.notification.create({
        data: {
          userId: review.report.researcher.userId,
          type: 'COMPLIANCE_PENDING',
          title: `이의가 받아들여졌습니다: ${review.report.title}`,
          body: '검수 오류로 확인됐습니다. 본문을 고치지 않고 그대로 다시 제출하시면 됩니다. 같은 표현이 다시 걸리지 않게 규칙을 손봅니다.',
          link: `/researcher/${review.report.researcherId}`,
          createdAt: now,
        },
      }) as never,
    );
  }
  await prisma.$transaction(writes);
}

/** 리서처 이의 — 상한·소명 하한은 domain/rejectAppeal. 접수되면 운영자에게 알린다 */
export async function fileRejectAppeal(
  prisma: PrismaClient,
  input: { reportId: string; researcherId: string; statement: string },
  now = new Date(),
): Promise<{ reviewId: string }> {
  const report = await prisma.report.findUnique({
    where: { id: input.reportId },
    select: { id: true, title: true, researcherId: true, rejectionCount: true },
  });
  if (!report || report.researcherId !== input.researcherId) throw new RejectAuditError('리포트를 찾을 수 없습니다');

  // 이 리포트의 가장 최근 즉시 거절 기록
  const review = await prisma.complianceReview.findFirst({
    where: { reportId: report.id, decision: 'BLOCK' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, operatorVerdict: true, appealAt: true },
  });
  if (!review) throw new RejectAuditError('이 리포트에는 즉시 거절 기록이 없습니다');

  // 미결 이의 = 이 리서처의 리포트에 걸린 BLOCK 기록 중 이의를 냈고 아직 판정이 없는 것
  const openAppeals = await prisma.complianceReview.count({
    where: { decision: 'BLOCK', appealAt: { not: null }, operatorVerdict: null, report: { researcherId: input.researcherId } },
  });
  const check = checkAppealAllowed({
    alreadyAppealed: review.appealAt !== null,
    alreadyAudited: review.operatorVerdict !== null,
    openAppeals,
    rejectionCount: report.rejectionCount,
    statement: input.statement,
  });
  if (!check.ok) throw new RejectAuditError(check.message);

  await prisma.complianceReview.update({
    where: { id: review.id },
    data: { appealStatement: input.statement.trim(), appealAt: now },
  });
  // 운영자에게 — 이의는 표본과 무관하게 훑기 큐 맨 앞에 선다. 실패해도 접수는 끝난 일
  await notifyOperators(prisma, {
    title: `[검수] 거절 이의 — ${report.title}`,
    body: `리서처가 즉시 거절에 이의를 냈습니다: "${input.statement.trim().slice(0, 80)}". 검수모델 탭의 거절 훑기에서 정탐/오탐을 정해 주세요.`,
    link: '/admin/compliance?tab=body',
    type: 'COMPLIANCE_REVIEW',
    dedupeKey: `reject.appeal.${review.id}`,
  }).catch((e) => console.error('거절 이의 알림 실패:', e));
  return { reviewId: review.id };
}
