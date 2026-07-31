import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getPendingComplianceReviews, markComplianceReviewed } from '@/server/complianceService';
import { prisma } from '@/server/db';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 컴플라이언스 검토 큐: WARN·검수 실패(UNAVAILABLE) 건 조회·확인 처리

const bodySchema = z.object({ reviewId: z.string().min(1) });

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json(await getPendingComplianceReviews(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** 확인 완료 처리 (큐에서 제거) */
export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const { reviewId } = bodySchema.parse(await req.json());
    await markComplianceReviewed(prisma, reviewId, operatorUserId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
