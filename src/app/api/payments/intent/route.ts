import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { createPaymentIntent } from '@/server/paymentIntentService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

const bodySchema = z.object({ reportId: z.string().min(1) });

/** 결제창을 띄우기 전, 서버에 주문(orderId·금액)을 먼저 기록한다 */
export async function POST(req: NextRequest) {
  try {
    const buyerId = await requireUserId();
    const { reportId } = bodySchema.parse(await req.json());
    const prepared = await createPaymentIntent(prisma, { reportId, buyerId });
    return NextResponse.json(prepared, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
