import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { ApprovalError, decideApproval, getPendingApprovals } from '@/server/operatorApprovalService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 승인 대기열 — **승인하는 사람도 운영자여야 한다.**
//
// 요청자가 자기 요청을 승인하지 못하는 규칙은 서비스가 지킨다(domain/operatorApproval).
// 여기서 하는 일은 "운영자인가"까지다.

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json(await getPendingApprovals(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

const bodySchema = z.object({
  approvalId: z.string().min(1),
  approve: z.boolean(),
  note: z.string().max(300).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const operatorId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const status = await decideApproval(prisma, {
      approvalId: body.approvalId,
      approverUserId: operatorId,
      approve: body.approve,
      note: body.note,
    });
    return NextResponse.json({ status });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof ApprovalError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    return toErrorResponse(e);
  }
}
