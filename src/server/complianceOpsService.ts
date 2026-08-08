import type { Prisma, PrismaClient } from '@prisma/client';
import { HOLD_OVERDUE_HOURS } from '@/domain/compliance';
import { createEmbeddingProviderFromEnv } from '@/infra/embedding/provider';
import { backfillPhraseVectors } from './semanticIndexService';

// 보류 큐 운영 배치.
//
// 지금 구조에는 단일 실패 지점이 있다: **보류된 리포트는 운영자가 볼 때까지 아무 일도
// 일어나지 않는다.** 알림은 보류 시점에 한 번 갈 뿐이고, 그 뒤로는 큐 페이지를 열어야만
// 알 수 있다. 운영자가 며칠 자리를 비우면 리서처는 판매를 못 한 채 방치되고, 검증 시한이
// 짧은 카드는 그 사이에 게시 자체가 불가능해진다.
//
// 이 배치가 두 가지를 처리한다:
//  ① 시한이 지나 승인해도 게시될 수 없는 보류 건을 자동으로 초안으로 되돌린다
//  ② 오래 대기 중인 건을 운영자에게 다시 알린다 (하루 1회, 요약 1건)

/** 자동 정리·재알림 결과 요약 (스크립트 출력용) */
export interface ComplianceOpsSummary {
  expired: { reportId: string; title: string }[];
  escalated: number;
  notifiedOperators: number;
  /** 의미 인덱스에 새로 계산한 벡터 수 (공급자가 없으면 null) */
  vectorsBackfilled: number | null;
}

/**
 * 검증 시한이 지난 보류 건을 초안으로 되돌린다.
 *
 * 승인 시점에 게시 조건(최소 시한·컷오프)을 다시 검증하므로, 시한이 지난 뒤에는
 * 운영자가 승인해도 실패한다. 큐에 남겨두면 처리할 수 없는 건이 계속 쌓여
 * 정말 봐야 할 건을 가린다.
 *
 * **운영자 판정 라벨은 남기지 않는다.** 이건 사람의 판단이 아니라 시간이 만든 결과라,
 * 검수 정확도 통계(정탐·오탐)에 섞이면 지표가 오염된다.
 */
export async function expireStaleHolds(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ reportId: string; title: string }[]> {
  const stale = await prisma.report.findMany({
    where: {
      status: 'PENDING_REVIEW',
      predictionCard: { deadline: { lte: now } },
    },
    select: {
      id: true,
      title: true,
      researcherId: true,
      researcher: { select: { userId: true } },
    },
  });
  if (stale.length === 0) return [];

  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (const report of stale) {
    writes.push(
      prisma.report.update({
        where: { id: report.id, status: 'PENDING_REVIEW' },
        // 반려 횟수는 올리지 않는다 — 리서처의 잘못이 아니다
        data: { status: 'DRAFT' },
      }),
      // 큐에서 내린다. 판정 라벨(operatorVerdict)은 비워 둔 채 확인만 처리한다
      prisma.complianceReview.updateMany({
        where: { reportId: report.id, needsOperatorReview: true, operatorReviewedAt: null },
        data: { operatorReviewedAt: now, operatorReviewedBy: 'system:expired' },
      }),
      prisma.notification.create({
        data: {
          userId: report.researcher.userId,
          type: 'COMPLIANCE_PENDING',
          title: `검토 대기 중 시한 경과: ${report.title}`,
          body:
            '운영자 검토를 기다리는 사이 예측 카드의 검증 시한이 지나 게시할 수 없게 되었습니다. ' +
            '초안으로 되돌렸으니 검증 시한을 다시 설정해 제출해주세요. 판매·정산은 발생하지 않았습니다.',
          link: `/researcher/${report.researcherId}`,
          createdAt: now,
        },
      }),
    );
  }
  await prisma.$transaction(writes);
  return stale.map((r) => ({ reportId: r.id, title: r.title }));
}

/**
 * 오래 대기 중인 보류 건을 운영자에게 다시 알린다.
 *
 * 건별로 알림을 쏘면 큐가 밀린 날에 알림 폭탄이 되어 오히려 무시된다.
 * 요약 1건으로 묶고, 같은 건에 대해서는 하루에 한 번만 재알림한다(escalatedAt).
 */
export async function escalateOverdueHolds(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ escalated: number; notifiedOperators: number }> {
  const overdueBefore = new Date(now.getTime() - HOLD_OVERDUE_HOURS * 3_600_000);
  const reNotifyBefore = new Date(now.getTime() - 24 * 3_600_000);

  const overdue = await prisma.complianceReview.findMany({
    where: {
      needsOperatorReview: true,
      operatorReviewedAt: null,
      createdAt: { lte: overdueBefore },
      OR: [{ escalatedAt: null }, { escalatedAt: { lte: reNotifyBefore } }],
    },
    select: { id: true, createdAt: true, report: { select: { title: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (overdue.length === 0) return { escalated: 0, notifiedOperators: 0 };

  const operators = await prisma.user.findMany({
    where: { role: 'OPERATOR' },
    select: { id: true },
  });
  const oldestHours = Math.floor((now.getTime() - overdue[0].createdAt.getTime()) / 3_600_000);
  const titles = overdue.slice(0, 3).map((r) => r.report.title);

  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.complianceReview.updateMany({
      where: { id: { in: overdue.map((r) => r.id) } },
      data: { escalatedAt: now },
    }),
  ];
  for (const op of operators) {
    writes.push(
      prisma.notification.create({
        data: {
          userId: op.id,
          type: 'COMPLIANCE_REVIEW',
          title: `[지연] 검토 대기 ${overdue.length}건 — 최장 ${oldestHours}시간`,
          body:
            `${HOLD_OVERDUE_HOURS}시간을 넘긴 보류 건이 ${overdue.length}건 있습니다. ` +
            `결정이 날 때까지 리서처는 판매를 시작할 수 없고, 검증 시한이 지나면 게시 자체가 불가능해집니다. ` +
            `예: ${titles.join(' / ')}${overdue.length > titles.length ? ' 외' : ''}`,
          link: '/admin/compliance',
          createdAt: now,
        },
      }),
    );
  }
  await prisma.$transaction(writes);
  return { escalated: overdue.length, notifiedOperators: operators.length };
}

export async function runComplianceOps(
  prisma: PrismaClient,
  now = new Date(),
): Promise<ComplianceOpsSummary> {
  // 만료 정리를 먼저 해야 이미 처리 불가능한 건에 대해 재알림이 나가지 않는다
  const expired = await expireStaleHolds(prisma, now);
  const { escalated, notifiedOperators } = await escalateOverdueHolds(prisma, now);

  // 새로 등록된 표현·모델 교체로 벡터가 없는 항목을 채운다.
  // 실패해도 나머지 운영 처리는 이미 끝났으므로 배치를 세우지 않는다.
  const embedder = createEmbeddingProviderFromEnv();
  const vectorsBackfilled = embedder
    ? await backfillPhraseVectors(prisma, embedder).catch((e) => {
        console.error('의미 인덱스 벡터 계산 실패:', e);
        return 0;
      })
    : null;

  return { expired, escalated, notifiedOperators, vectorsBackfilled };
}
