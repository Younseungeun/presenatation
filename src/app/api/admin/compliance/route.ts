import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { RISK_CATEGORIES, type RiskCategory } from '@/domain/compliance';
import { PHRASE_MAX_LENGTH, validatePhrase } from '@/domain/learnedPhrases';
import { createLearnedPhrase, setLearnedPhraseActive } from '@/server/learnedPhraseService';
import { createDefaultRegistry } from '@/infra/marketData/registry';
import {
  forceWithdrawReport,
  getPendingComplianceReviews,
  markComplianceReviewed,
} from '@/server/complianceService';
import { prisma } from '@/server/db';
import { approvePendingReport, rejectPendingReport } from '@/server/reportService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 컴플라이언스 검토 큐: 2단 검수로 결론이 안 난 건에 대한 결정.
// 보류(PENDING_REVIEW) 건 — 아직 판매 전이므로 환불 문제가 없다
//  - APPROVE: 게시 승인 (기준가·수수료는 이 시점에 확정)
//  - REJECT: 반려 → 초안으로 되돌림 (사유 통지)
// 이미 게시된 건 — 승인 후 재검토·구버전 데이터
//  - RESOLVE: 게시 유지 (큐에서 제거)
//  - TAKEDOWN: 강제 철회 → 게시 중단 + 즉시 전액 환불

// 운영자 결정에는 정답 라벨이 함께 실린다 (screeningAccuracy.ts):
//  - 승인: findingsValid — 지적이 타당했는지 (기본 false = 오탐)
//  - 반려·철회: categories — 실제 위반 유형 (비우면 검수 소견을 그대로 인정)
const categories = z.array(z.enum(RISK_CATEGORIES)).max(RISK_CATEGORIES.length).optional();

// 반려·철회와 함께 등록하는 학습 표현 — 다음 리서처가 작성 단계에서 미리 경고를 받는다.
// 반려 사유를 남기는 김에 한 줄 더 적는 것이므로 운영자의 추가 작업은 거의 없다.
const phrase = z.string().trim().max(PHRASE_MAX_LENGTH * 3).optional();

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('RESOLVE'), reviewId: z.string().min(1) }),
  z.object({
    action: z.literal('APPROVE'),
    reportId: z.string().min(1),
    findingsValid: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('REJECT'),
    reportId: z.string().min(1),
    reason: z.string().trim().min(1).max(500),
    categories,
    phrase,
  }),
  z.object({
    action: z.literal('TAKEDOWN'),
    reportId: z.string().min(1),
    reason: z.string().trim().min(1).max(500),
    categories,
    phrase,
  }),
  z.object({
    action: z.literal('SET_PHRASE_ACTIVE'),
    phraseId: z.string().min(1),
    active: z.boolean(),
  }),
]);

/**
 * 반려와 함께 들어온 표현을 사전에 등록한다.
 * 표현이 잘못됐다고 반려 자체를 되돌리지는 않는다 — 반려는 이미 확정된 판단이고,
 * 사전 등록은 부가 작업이다. 대신 실패 사유를 응답에 실어 운영자가 다시 시도하게 한다.
 */
async function registerPhrase(
  operatorUserId: string,
  reportId: string,
  text: string | undefined,
  cats: RiskCategory[] | undefined,
  reason: string,
): Promise<string | null> {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const category = cats?.[0];
  if (!category) return '표현을 등록하려면 실제 위반 유형을 한 개 이상 선택해주세요';
  const issues = validatePhrase(trimmed);
  if (issues.length > 0) return issues.join(' / ');
  await createLearnedPhrase(prisma, {
    phrase: trimmed,
    category,
    note: reason,
    createdBy: operatorUserId,
    sourceReportId: reportId,
  });
  return null;
}

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json(await getPendingComplianceReviews(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const raw = (await req.json()) as Record<string, unknown>;
    // action 미지정은 기존 확인 처리로 해석 (하위 호환)
    const body = bodySchema.parse({ action: 'RESOLVE', ...raw });

    switch (body.action) {
      case 'APPROVE': {
        const published = await approvePendingReport(
          prisma,
          createDefaultRegistry(),
          body.reportId,
          operatorUserId,
          new Date(),
          body.findingsValid ?? false,
        );
        return NextResponse.json({ ok: true, status: published.status });
      }
      case 'REJECT':
        await rejectPendingReport(
          prisma,
          body.reportId,
          operatorUserId,
          body.reason,
          new Date(),
          body.categories ?? [],
        );
        return NextResponse.json({
          ok: true,
          phraseWarning: await registerPhrase(
            operatorUserId,
            body.reportId,
            body.phrase,
            body.categories,
            body.reason,
          ),
        });
      case 'SET_PHRASE_ACTIVE':
        await setLearnedPhraseActive(prisma, body.phraseId, body.active);
        return NextResponse.json({ ok: true });
      case 'TAKEDOWN': {
        const summary = await forceWithdrawReport(prisma, {
          reportId: body.reportId,
          operatorUserId,
          reason: body.reason,
          categories: body.categories ?? [],
        });
        return NextResponse.json({
          ok: true,
          ...summary,
          phraseWarning: await registerPhrase(
            operatorUserId,
            body.reportId,
            body.phrase,
            body.categories,
            body.reason,
          ),
        });
      }
      default:
        await markComplianceReviewed(prisma, body.reviewId, operatorUserId);
        return NextResponse.json({ ok: true });
    }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
