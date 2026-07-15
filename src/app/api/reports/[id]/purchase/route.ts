import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/server/db';
import { purchaseReport } from '@/server/purchaseService';
import { requireUserId, toErrorResponse } from '../../../_lib/http';

/**
 * 리포트 구매 — 결제(PG 스텁) 후 에스크로 보관.
 * 판정 결과에 따라 배치가 정산한다: 적중 → 리서처 정산 / 실패 → 현금 환불 / 불가 → 전액 환불
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const buyerId = await requireUserId();
    const { id } = await ctx.params;
    const purchase = await purchaseReport(prisma, id, buyerId);
    return NextResponse.json(purchase, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
