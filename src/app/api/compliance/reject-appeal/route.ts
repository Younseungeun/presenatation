import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { fileRejectAppeal, RejectAuditError } from '@/server/rejectAuditService';
import { requireResearcherId, toErrorResponse } from '../../_lib/http';

// 거절 이의 (B1) — 리서처 본인의 리포트, 가장 최근 즉시 거절에 대해서만. 상한·소명 하한은
// 서비스(domain/rejectAppeal)가 최종 관문이다 — 화면의 글자 수 검사는 미리 알려 주는 것뿐.

const bodySchema = z.object({
  reportId: z.string().min(1),
  statement: z.string().trim().min(1).max(600),
});

export async function POST(req: NextRequest) {
  try {
    const researcherId = await requireResearcherId(prisma);
    const body = bodySchema.parse(await req.json());
    const r = await fileRejectAppeal(prisma, { ...body, researcherId });
    return NextResponse.json({ ok: true, reviewId: r.reviewId });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof RejectAuditError) return NextResponse.json({ error: e.message }, { status: 400 });
    return toErrorResponse(e);
  }
}
