import type { PrismaClient } from '@prisma/client';
import {
  applyRules,
  decide,
  mergeFindings,
  type ComplianceResult,
  type Finding,
  type ScreeningInput,
} from '@/domain/compliance';
import type { ComplianceScreener } from '@/infra/compliance/screener';

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

  let aiFindings: Finding[];
  try {
    aiFindings = await screener.screen(input);
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

  const findings = mergeFindings(ruleFindings, aiFindings);
  const decision = decide(findings);
  return {
    decision,
    findings,
    reviewer: `rule+${screener.reviewerId}`,
    needsOperatorReview: decision === 'WARN',
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
  await prisma.complianceReview.create({
    data: {
      reportId,
      decision: result.decision,
      reviewer: result.reviewer,
      findingsJson: JSON.stringify(result.findings),
      needsOperatorReview: result.needsOperatorReview,
      createdAt: now,
    },
  });
  return result;
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
