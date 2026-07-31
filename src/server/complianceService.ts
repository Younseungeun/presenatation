import type { Prisma, PrismaClient } from '@prisma/client';
import {
  applyRules,
  decide,
  mergeFindings,
  type ComplianceResult,
  type ScreeningInput,
} from '@/domain/compliance';
import {
  deliberationRatio,
  type ComplianceScreener,
  type ScreeningOutput,
  type ScreeningUsage,
} from '@/infra/compliance/screener';
import { buildJudgmentWrites } from './judgmentWriter';

// 게시 전 컴플라이언스 검수 실행·기록.
//
// 순서: 결정적 규칙 → (규칙이 차단하지 않았으면) AI 검수 → 병합 → 결정 → 기록.
// 규칙이 이미 BLOCK을 냈으면 AI를 호출하지 않는다 (결과가 바뀌지 않는데 비용·지연만 든다).

/** 검수 실행 (기록 없음) — 순수 조합 로직이라 테스트가 쉽다 */
export async function runScreening(
  input: ScreeningInput,
  screener: ComplianceScreener | null,
): Promise<ComplianceResult> {
  const ruleFindings = applyRules(input);
  const ruleDecision = decide(ruleFindings);

  // 규칙이 차단했거나 AI 검수기가 없으면 규칙 결과가 최종
  if (ruleDecision === 'BLOCK' || !screener) {
    return {
      decision: ruleDecision,
      findings: ruleFindings,
      reviewer: 'rule',
      needsOperatorReview: ruleDecision === 'WARN',
    };
  }

  let output: ScreeningOutput;
  try {
    output = await screener.screen(input);
  } catch (e) {
    // 검수 실패로 게시를 막지 않는다 — 외부 장애가 서비스 중단으로 번지지 않게.
    // 대신 운영자 검토 대상으로 돌린다.
    console.error('컴플라이언스 AI 검수 실패:', e);
    return {
      decision: 'UNAVAILABLE',
      findings: ruleFindings,
      reviewer: `rule+${screener.reviewerId}(실패)`,
      needsOperatorReview: true,
    };
  }

  const findings = mergeFindings(ruleFindings, output.findings);
  const decision = decide(findings);
  return {
    decision,
    findings,
    reviewer: `rule+${screener.reviewerId}`,
    needsOperatorReview: decision === 'WARN',
    usage: output.usage,
  };
}

/** 검수 실행 + 이력 기록. 차단된 시도도 남긴다 (반복 위반 탐지 근거) */
export async function screenAndRecord(
  prisma: PrismaClient,
  reportId: string,
  input: ScreeningInput,
  screener: ComplianceScreener | null,
  now = new Date(),
): Promise<ComplianceResult> {
  const result = await runScreening(input, screener);
  const usage = result.usage as ScreeningUsage | undefined;

  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.complianceReview.create({
      data: {
        reportId,
        decision: result.decision,
        reviewer: result.reviewer,
        findingsJson: JSON.stringify(result.findings),
        needsOperatorReview: result.needsOperatorReview,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        deliberationRatio: usage ? deliberationRatio(usage) : null,
        createdAt: now,
      },
    }),
  ];

  // 2단 검수로 결론이 나지 않은 건은 운영자에게 즉시 알린다.
  // 큐 페이지를 열어봐야만 알 수 있으면 위반 콘텐츠가 팔리는 시간이 길어진다.
  if (result.needsOperatorReview) {
    const operators = await prisma.user.findMany({
      where: { role: 'OPERATOR' },
      select: { id: true },
    });
    const label = result.decision === 'UNAVAILABLE' ? 'AI 검수 실패' : '검수 경고';
    for (const op of operators) {
      writes.push(
        prisma.notification.create({
          data: {
            userId: op.id,
            type: 'COMPLIANCE_REVIEW',
            title: `[${label}] 컴플라이언스 검토 필요: ${input.title}`,
            body:
              result.decision === 'UNAVAILABLE'
                ? 'AI 검수가 실패해 결정적 규칙만 적용된 채 게시됐습니다. 본문을 직접 확인해 게시 유지 또는 강제 철회를 결정해주세요.'
                : `${result.findings.map((f) => f.reason).join(' / ')} — 게시 유지 또는 강제 철회를 결정해주세요.`,
            link: '/admin/compliance',
            createdAt: now,
          },
        }),
      );
    }
  }

  await prisma.$transaction(writes);
  return result;
}

/**
 * 검수 비용·숙고량 통계 — 모델 선택과 에스컬레이션 임계값을 데이터로 정하기 위한 집계.
 * 운영 초기 수십 건만 쌓여도 실제 분포가 보인다.
 */
export async function getScreeningUsageStats(prisma: PrismaClient) {
  const rows = await prisma.complianceReview.findMany({
    where: { inputTokens: { not: null } },
    select: { inputTokens: true, outputTokens: true, deliberationRatio: true, decision: true },
    orderBy: { createdAt: 'desc' },
    take: 1_000,
  });
  if (rows.length === 0) return null;

  const sum = (pick: (r: (typeof rows)[number]) => number) =>
    rows.reduce((acc, r) => acc + pick(r), 0);
  const ratios = rows
    .map((r) => r.deliberationRatio ?? 0)
    .sort((a, b) => a - b);
  const percentile = (p: number) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))];

  return {
    samples: rows.length,
    avgInputTokens: Math.round(sum((r) => r.inputTokens ?? 0) / rows.length),
    avgOutputTokens: Math.round(sum((r) => r.outputTokens ?? 0) / rows.length),
    // 임계값 후보 — 상위 10~20%를 자르는 선이 에스컬레이션 기준이 된다
    ratioP50: percentile(0.5),
    ratioP80: percentile(0.8),
    ratioP90: percentile(0.9),
  };
}

/** 운영자 검토 대기 큐 — 미확인 WARN·UNAVAILABLE (오래된 순) */
export function getPendingComplianceReviews(prisma: PrismaClient) {
  return prisma.complianceReview.findMany({
    where: { needsOperatorReview: true, operatorReviewedAt: null },
    include: {
      report: {
        select: {
          id: true,
          title: true,
          status: true,
          researcher: {
            select: { user: { select: { penName: true, email: true } } },
          },
          // 강제 철회 시 환불될 규모 — 운영자가 집행 전에 영향 범위를 보고 판단해야 한다
          purchases: { where: { escrowStatus: 'HELD' }, select: { amountKrw: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/** 운영자 확인 처리 (큐에서 제거) */
export async function markComplianceReviewed(
  prisma: PrismaClient,
  reviewId: string,
  operatorUserId: string,
  now = new Date(),
) {
  await prisma.complianceReview.update({
    where: { id: reviewId, operatorReviewedAt: null },
    data: { operatorReviewedAt: now, operatorReviewedBy: operatorUserId },
  });
}

// ── 강제 철회 (운영자 집행 액션) ────────────────────────────────────────
//
// 검토 큐의 WARN·UNAVAILABLE 건을 확인한 결과 실제로 위반이라고 판단했을 때,
// 이미 게시된 리포트를 운영자가 내린다. 확인 도장만 찍는 큐는 집행 수단이 없어
// 규제 리스크를 실제로 줄이지 못한다.
//
// 원칙:
// - 구매자 보호 우선: 시한을 기다리지 않고 즉시 판정 불가(WITHDRAWN) 처리 →
//   에스크로 전액 환불, 플랫폼 수수료 0, 리서처 정산 0 (§2.5·§3.3)
// - 리서처 점수는 0점 (표본 제외) — 위반 콘텐츠가 트랙레코드에 남지 않게
// - 판정·정산·알림은 자동 경로와 동일 함수(buildJudgmentWrites) 공유
// - 사유 필수 + 운영자 식별자를 감사 스냅샷에 기록 (분쟁 재현·이의 제기 대응)
// - 기록은 지우지 않는다: 카드·리포트·검수 이력 모두 보존하고 상태만 CLOSED로 전이

export class ComplianceTakedownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceTakedownError';
  }
}

export interface TakedownInput {
  reportId: string;
  operatorUserId: string;
  /** 강제 철회 사유 — 필수. 리서처 알림과 감사 스냅샷에 그대로 실린다 */
  reason: string;
}

export interface TakedownSummary {
  reportId: string;
  /** 환불 대상이 된 에스크로 보관 구매 건수 */
  refundedPurchases: number;
  refundedAmountKrw: number;
}

export async function forceWithdrawReport(
  prisma: PrismaClient,
  input: TakedownInput,
  now = new Date(),
): Promise<TakedownSummary> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ComplianceTakedownError('강제 철회 사유는 필수입니다');
  }

  const report = await prisma.report.findUnique({
    where: { id: input.reportId },
    include: {
      purchases: { where: { escrowStatus: 'HELD' } },
      researcher: { select: { userId: true } },
      predictionCard: { include: { judgment: { select: { id: true } } } },
    },
  });
  if (!report) throw new ComplianceTakedownError('리포트를 찾을 수 없습니다');
  if (report.status !== 'PUBLISHED') {
    throw new ComplianceTakedownError(
      report.status === 'DRAFT'
        ? '게시되지 않은 초안은 강제 철회 대상이 아닙니다'
        : '이미 철회·종료된 리포트입니다',
    );
  }
  const card = report.predictionCard;
  if (!card) throw new ComplianceTakedownError('예측 카드가 없습니다');
  if (card.judgment) {
    throw new ComplianceTakedownError(
      '이미 판정이 완료된 카드입니다 — 정산이 끝난 건은 철회할 수 없습니다',
    );
  }
  if (card.withdrawnAt) throw new ComplianceTakedownError('이미 철회된 카드입니다');

  const audit = {
    takedown: true,
    operatorUserId: input.operatorUserId,
    reason,
    reportId: report.id,
    withdrawnAt: now.toISOString(),
  };

  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.predictionCard.update({ where: { id: card.id }, data: { withdrawnAt: now } }),
    prisma.report.update({
      // 동시 요청 대비: PUBLISHED 조건을 다시 걸어 원자적으로 전이
      where: { id: report.id, status: 'PUBLISHED' },
      data: { status: 'CLOSED' },
    }),
    // 판정 불가(WITHDRAWN) 즉시 확정 → 전액 환불 지시서 + 당사자 알림까지 자동 경로와 동일
    ...buildJudgmentWrites(
      prisma,
      { ...card, report: { ...report, purchases: report.purchases } },
      {
        result: { outcome: 'UNDECIDABLE', undecidableReason: 'WITHDRAWN' },
        realizedReturnPct: null,
        score: 0, // 판정 불가는 표본 제외 (§2.2)
        dataSource: `takedown:${input.operatorUserId}`,
        audit,
      },
      now,
    ),
    // 사유가 담긴 별도 통지 — 리서처가 무엇을 고쳐야 하는지 알아야 재발이 줄어든다
    prisma.notification.create({
      data: {
        userId: report.researcher.userId,
        type: 'COMPLIANCE_TAKEDOWN',
        title: `운영자 강제 철회: ${report.title}`,
        body: `컴플라이언스 검토 결과 게시가 중단되었습니다. 사유: ${reason} · 구매자에게는 전액 환불되며 이 카드는 점수에 반영되지 않습니다.`,
        link: `/report/${report.id}`,
        createdAt: now,
      },
    }),
    // 이 리포트의 미확인 검토 건은 집행으로 종결 처리 (큐에 남겨둘 이유가 없다)
    prisma.complianceReview.updateMany({
      where: { reportId: report.id, needsOperatorReview: true, operatorReviewedAt: null },
      data: { operatorReviewedAt: now, operatorReviewedBy: input.operatorUserId },
    }),
  ];

  await prisma.$transaction(writes);

  return {
    reportId: report.id,
    refundedPurchases: report.purchases.length,
    refundedAmountKrw: report.purchases.reduce((sum, p) => sum + p.amountKrw, 0),
  };
}
