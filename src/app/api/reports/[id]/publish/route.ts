import { NextResponse, type NextRequest } from 'next/server';
import { createDefaultRegistry } from '@/infra/marketData/registry';
import { prisma } from '@/server/db';
import { publishReport } from '@/server/reportService';
import { requireResearcherId, toErrorResponse } from '../../../_lib/http';

/**
 * 리포트 게시 — 기준가·수수료 고정, 예측 카드 잠금 (되돌릴 수 없음).
 * 이후 수정·삭제 API는 존재하지 않으며, 철회(/withdraw)만 가능하다.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const researcherId = requireResearcherId(req);
    const { id } = await ctx.params;
    const report = await publishReport(prisma, createDefaultRegistry(), id, researcherId);
    return NextResponse.json(report);
  } catch (e) {
    return toErrorResponse(e);
  }
}
