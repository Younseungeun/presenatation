import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  forceWithdrawReport,
  getPendingComplianceReviews,
  markComplianceReviewed,
} from '@/server/complianceService';
import { prisma } from '@/server/db';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 컴플라이언스 검토 큐: WARN·검수 실패(UNAVAILABLE) 건 조회 + 두 가지 집행 액션
//  - RESOLVE: 확인만 (문제 없음 → 큐에서 제거)
//  - TAKEDOWN: 실제 위반 → 게시 중단 + 즉시 전액 환불

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('RESOLVE'), reviewId: z.string().min(1) }),
  z.object({
    action: z.literal('TAKEDOWN'),
    reportId: z.string().min(1),
    reason: z.string().trim().min(1).max(500),
  }),
]);

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

    if (body.action === 'TAKEDOWN') {
      const summary = await forceWithdrawReport(prisma, {
        reportId: body.reportId,
        operatorUserId,
        reason: body.reason,
      });
      return NextResponse.json({ ok: true, ...summary });
    }

    await markComplianceReviewed(prisma, body.reviewId, operatorUserId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
