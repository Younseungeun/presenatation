import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import {
  executePayout,
  executeRefund,
  getPendingPayouts,
  getPendingRefunds,
  REFUND_METHODS,
  retryRefundAttempt,
} from '@/server/settlementOpsService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 정산 콘솔: 미실행 환불·지급 지시서 조회 + 실행 기록

const bodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('REFUND'),
    settlementId: z.string().min(1),
    method: z.enum(REFUND_METHODS),
  }),
  // 끝나지 않은 시도를 **같은 멱등키로** 이어받는다 — 새 실행과 반드시 구분해야 한다
  z.object({ kind: z.literal('REFUND_RETRY'), attemptId: z.string().min(1) }),
  z.object({ kind: z.literal('PAYOUT'), settlementId: z.string().min(1) }),
]);

export async function GET() {
  try {
    await requireOperatorId(prisma);
    const [refunds, payouts] = await Promise.all([
      getPendingRefunds(prisma),
      getPendingPayouts(prisma),
    ]);
    return NextResponse.json({ refunds, payouts });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    if (body.kind === 'REFUND') {
      await executeRefund(prisma, {
        settlementId: body.settlementId,
        operatorUserId,
        method: body.method,
      });
    } else if (body.kind === 'REFUND_RETRY') {
      await retryRefundAttempt(prisma, { attemptId: body.attemptId, operatorUserId });
    } else {
      await executePayout(prisma, { settlementId: body.settlementId, operatorUserId });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
