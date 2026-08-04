import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { createFreeReport } from '@/server/freeReportService';
import { requireResearcherId, toErrorResponse } from '../../_lib/http';

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(300),
  content: z.string().min(1),
});

/**
 * 무료 시황 리포트 게시 — 예측 카드가 없으므로 초안 단계 없이 바로 공개된다.
 * 판정·정산 대상이 아니라 유료 게시(POST /api/reports)와는 완전히 다른 경로다.
 */
export async function POST(req: NextRequest) {
  try {
    const researcherId = await requireResearcherId(prisma);
    const body = bodySchema.parse(await req.json());
    const report = await createFreeReport(prisma, { researcherId, ...body });
    return NextResponse.json({ id: report.id }, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
