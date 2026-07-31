import type { PrismaClient } from '@prisma/client';
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
  await prisma.complianceReview.create({
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
  });
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
