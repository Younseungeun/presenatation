import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getAbuseReports, reviewAbuseReport } from '@/server/abuseReportService';
import { prisma } from '@/server/db';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 신고 검토 — 확인(보상 판단 포함)·기각. 목록 조회는 콘솔 화면용.

const bodySchema = z.object({
  id: z.string().min(1),
  decision: z.enum(['CONFIRMED', 'REJECTED']),
  note: z.string().min(1, '검토 사유를 적어 주세요').max(2000),
});

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json(await getAbuseReports(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const result = await reviewAbuseReport(prisma, { ...body, operatorUserId });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues[0]?.message ?? '요청 형식 오류' },
        { status: 400 },
      );
    }
    return toErrorResponse(e);
  }
}
