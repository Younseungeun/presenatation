import { NextResponse, type NextRequest } from 'next/server';
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
      /* **게시 검수에 외부 AI 를 붙이지 않는다** (2026-08-24 창업자 확정).
         자동 검수는 규칙 엔진 + IRIS 로 끝나고, Claude 는 교사(오프라인 라벨)로만 쓴다.
         예전에는 여기서 `createClaudeScreenerFromEnv()` 를 불러서 **키가 들어오는 날
         아무 경고 없이 외부 호출이 시작되는** 구조였다 — 금지는 문서에만 있었다.
         지금은 그 함수가 쓰임새를 요구하고 게시 검수에는 댈 값이 없다(claudeScreener.ts). */
      null,
    );
    return NextResponse.json(report);
  } catch (e) {
    return toErrorResponse(e);
  }
}
