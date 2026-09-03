import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { getRejectAuditQueue, labelRejectReview, RejectAuditError } from '@/server/rejectAuditService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

// 거절 훑기 (B1) — 판정 없는 즉시 거절 기록에 정탐/오탐을 붙인다. 리포트 상태는 안 건드린다.

const labelSchema = z.object({
  reviewId: z.string().min(1),
  verdict: z.enum(['TP', 'FP']),
});

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json(await getRejectAuditQueue(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = labelSchema.parse(await req.json());
    await labelRejectReview(prisma, { ...body, operatorUserId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof RejectAuditError) return NextResponse.json({ error: e.message }, { status: 400 });
    return toErrorResponse(e);
  }
}
