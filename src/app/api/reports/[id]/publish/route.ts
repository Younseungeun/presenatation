import { NextResponse, type NextRequest } from 'next/server';
import { createDefaultRegistry } from '@/infra/marketData/registry';
import { prisma } from '@/server/db';
import { HoldConfirmationRequired, publishReport } from '@/server/reportService';
import { requireResearcherId, toErrorResponse } from '../../../_lib/http';

/**
 * 리포트 게시 — 컴플라이언스 검수 통과 후 기준가·수수료 고정, 예측 카드 잠금 (되돌릴 수 없음).
 * 이후 수정·삭제 API는 존재하지 않으며, 철회(/withdraw)만 가능하다.
 *
 * 게시 전 되묻기(회신 22호): 기본은 acknowledgeHold=false 로 부른다 — 보류감이면 게시하지 않고
 * 팝업 정보(needsHoldConfirm)를 돌려준다. 리서처가 "그래도 게시" 를 누르면 UI 가
 * { acknowledgeHold: true } 로 다시 부르고, 그때 종전대로 보류 큐로 들어간다.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const researcherId = await requireResearcherId(prisma);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { acknowledgeHold?: unknown };
    const acknowledgeHold = body?.acknowledgeHold === true;
    const report = await publishReport(
      prisma,
      createDefaultRegistry(),
      id,
      researcherId,
      new Date(),
      /* **게시 검수에 외부 AI 를 붙이지 않는다** (2026-08-24 창업자 확정).
         자동 검수는 규칙 엔진 + ARGOS 로 끝나고, Claude 는 교사(오프라인 라벨)로만 쓴다.
         예전에는 여기서 `createClaudeScreenerFromEnv()` 를 불러서 **키가 들어오는 날
         아무 경고 없이 외부 호출이 시작되는** 구조였다 — 금지는 문서에만 있었다.
         지금은 그 함수가 쓰임새를 요구하고 게시 검수에는 댈 값이 없다(claudeScreener.ts). */
      null,
      acknowledgeHold,
    );
    return NextResponse.json(report);
  } catch (e) {
    // 게시 전 되묻기 — 오류가 아니라 확인 요청이다(200). 어느 문장이 걸렸는지는 싣지 않고
    // 위반 유형·위험 수준만 전한다(우회 오라클 방어).
    if (e instanceof HoldConfirmationRequired) {
      return NextResponse.json({
        needsHoldConfirm: true,
        decision: e.decision,
        categories: e.categories,
        repeated: e.repeated,
      });
    }
    return toErrorResponse(e);
  }
}
