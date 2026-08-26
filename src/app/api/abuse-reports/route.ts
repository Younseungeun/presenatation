import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  ABUSE_CATEGORIES,
  createAbuseReport,
} from '@/server/abuseReportService';
import { prisma } from '@/server/db';
import { requireUserId, toErrorResponse } from '../_lib/http';

// 클린 리서치 신고 접수 — 로그인 사용자만. 보상 판단은 운영자 검토(별도 API)에서.

const bodySchema = z.object({
  targetName: z.string().min(1, '대상을 입력해 주세요').max(200),
  category: z.enum(ABUSE_CATEGORIES),
  detail: z.string().min(10, '정황을 10자 이상 적어 주세요').max(4000),
  reportId: z.string().max(64).optional(),
  // 본문을 산 신고자의 문장별 지적 (없을 수 있다)
  findings: z
    .array(
      z.object({ quote: z.string().min(1).max(2000), category: z.enum(ABUSE_CATEGORIES) }),
    )
    .max(20)
    .optional(),
});

export async function POST(req: NextRequest) {
  try {
    const reporterId = await requireUserId();
    const body = bodySchema.parse(await req.json());
    const created = await createAbuseReport(prisma, { reporterId, ...body });
    return NextResponse.json({ id: created.id }, { status: 201 });
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
