import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { finishPasskeyRegistration, startPasskeyRegistration } from '@/server/passkeyService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

// 기기 등록 — **로그인한 사람만 자기 계정에 등록한다.**
//
// 등록 대상을 요청에서 받지 않는다(`requireUserId`가 준 id만 쓴다). 받게 두면
// 남의 계정에 내 기기를 심는 창구가 된다 — 이 API에서 가장 비싼 실수다.

/** 어떤 기기인지 물어보는 옵션(챌린지 포함)을 만든다 */
export async function GET() {
  try {
    return NextResponse.json(await startPasskeyRegistration(prisma, await requireUserId()));
  } catch (e) {
    return toErrorResponse(e);
  }
}

const bodySchema = z.object({
  response: z.any(),
  /** 사용자가 알아볼 이름 — 어느 기기를 지울지 고르려면 필요하다 */
  label: z.string().min(1).max(40),
});

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = bodySchema.parse(await req.json());
    const r = await finishPasskeyRegistration(prisma, {
      userId,
      response: body.response,
      label: body.label,
    });
    return NextResponse.json(r, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
