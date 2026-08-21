import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { quarantineRegressionCase } from '@/server/phraseGraduationService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

/**
 * 회귀 문항 격리 — 시험지에서 문항 하나를 **영구히** 뺀다.
 *
 * ── 왜 관문이 붙어 있는가 ──────────────────────────────────────
 * 회귀셋을 혼자 편집할 수 있으면 릴리스 압박과 함께 "학생이 틀리는 문항 지우기"
 * 유혹이 온다. 그래서 승인서 하나(1회용)를 태워야 하고, 운영자가 1명인 지금은
 * 그 자리를 **생체 재확인**이 대신한다. 화면은 `RECHECK_REQUIRED` 를 받으면 지문을
 * 띄우고 받은 표를 실어 한 번만 재시도한다 (UnfreezeForm 과 같은 흐름).
 *
 * ── 되돌릴 수 없다 ────────────────────────────────────────────
 * 격리 해제 함수는 없고 만들 계획도 없다 (회신 3호 B-2) — 되돌릴 수 있으면
 * "일단 빼고 릴리스, 나중에 복구"라는 우회로가 생긴다. 행은 감사용으로 영구 보존되지만
 * 게이트로는 돌아오지 않는다. 화면 문구가 그 사실을 먼저 말해야 한다.
 *
 * **한 요청에 한 문항이다.** 승인서가 1회용이라 목록에서 여럿을 골라 한 번에
 * 처리하는 입구는 만들 수 없다 — 만들면 관문이 개수만큼 약해진다.
 */

const bodySchema = z.object({
  caseId: z.string().min(1),
  reason: z.string().min(1, '격리 사유가 필요합니다').max(1000),
  /** 1인 운영 모드에서 생체 재확인으로 받은 1회용 표 (60초) */
  recheckToken: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    await quarantineRegressionCase(prisma, { ...body, operatorUserId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // GraduationError 의 code(RECHECK_REQUIRED · APPROVAL_PENDING)를 그대로 싣는다
    return toErrorResponse(e);
  }
}
