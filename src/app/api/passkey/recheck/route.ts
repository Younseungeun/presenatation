import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { finishPasskeyLogin, startPasskeyLogin } from '@/server/passkeyService';
import { issueOperatorRecheck } from '@/server/operatorApprovalService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 생체 재확인 (2026-08-17 사용자 확정 — 1인 운영 모드).
//
// 2인 승인의 두 번째 사람 자리를 **실행 직전 지문·얼굴 확인**이 대신한다.
// 로그인이 아니다 — 이미 로그인한 운영자가 "지금 화면 앞의 사람이 그 사람"임을
// 기기 생체로 다시 증명하는 것이다. 그래서 서명한 자격증명의 주인이
// **현재 세션의 운영자와 같은 사람**인지까지 본다 — 다르면 남의 지문이다.

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json(await startPasskeyLogin(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

const bodySchema = z.object({ response: z.any() });

export async function POST(req: NextRequest) {
  try {
    const operatorId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const { userId } = await finishPasskeyLogin(prisma, body.response);
    if (userId !== operatorId) {
      // 다른 계정의 패스키다 — 세션 주인의 생체가 아니면 재확인이 아니다
      return NextResponse.json({ error: '이 기기의 생체로는 확인할 수 없습니다' }, { status: 403 });
    }
    // **표는 이 응답으로만 나간다** — 세션만 훔친 쪽은 생체를 통과할 수 없으므로
    // 이 값을 손에 넣지 못한다. 사용자 단위로만 도장을 찍으면 훔친 세션이 창업자의
    // 재확인에 얹혀 가는데, 그건 이 장치가 막겠다고 한 바로 그 상대다
    const token = await issueOperatorRecheck(prisma, operatorId);
    return NextResponse.json({ ok: true, token });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
