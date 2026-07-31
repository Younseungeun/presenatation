import { NextResponse, type NextRequest } from 'next/server';
import { createClaudeScreenerFromEnv } from '@/infra/compliance/claudeScreener';
import { createDefaultRegistry } from '@/infra/marketData/registry';
import { prisma } from '@/server/db';
import { publishReport } from '@/server/reportService';
import { requireResearcherId, toErrorResponse } from '../../../_lib/http';

/**
 * 리포트 게시 — 컴플라이언스 검수 통과 후 기준가·수수료 고정, 예측 카드 잠금 (되돌릴 수 없음).
 * 이후 수정·삭제 API는 존재하지 않으며, 철회(/withdraw)만 가능하다.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const researcherId = await requireResearcherId(prisma);
    const { id } = await ctx.params;
    const report = await publishReport(
      prisma,
      createDefaultRegistry(),
      id,
      researcherId,
      new Date(),
      // API 키가 없으면 null → 결정적 규칙만 적용된다
      createClaudeScreenerFromEnv(),
    );
    return NextResponse.json(report);
  } catch (e) {
    return toErrorResponse(e);
  }
}
