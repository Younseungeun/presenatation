import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { answerSupportTicket } from '@/server/supportService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 문의 답변 — 답변 저장과 이용자 알림이 한 트랜잭션에서 일어난다
// (supportService.answerSupportTicket). 여기서는 인증과 형식만 본다.

const bodySchema = z.object({
  id: z.string().min(1),
  answer: z.string().min(1, '답변 내용은 필수입니다').max(2000),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const updated = await answerSupportTicket(prisma, { ...body, operatorUserId });
    return NextResponse.json({ ok: true, id: updated.id });
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
