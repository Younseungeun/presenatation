import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/server/db';
import { withdrawPredictionCard } from '@/server/reportService';
import { requireResearcherId, toErrorResponse } from '../../../_lib/http';

/**
 * 예측 카드 철회 — 기록은 남고(withdrawnAt) 판매만 중지된다.
 * 판정 시 UNDECIDABLE(WITHDRAWN) → 구매자 전액 환불.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const researcherId = await requireResearcherId(prisma);
    const { id } = await ctx.params;
    await withdrawPredictionCard(prisma, id, researcherId);
    return NextResponse.json({ withdrawn: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
