import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { finishPasskeyLogin, startPasskeyLogin } from '@/server/passkeyService';
import { setSessionCookie } from '@/server/session';
import { toErrorResponse } from '../../_lib/http';

// 생체 로그인 — 로그인 전이라 인증이 없다. 그래서 **응답이 아무것도 알려주지 않아야** 한다.
//
// 누구인지 묻지 않고 시작하고(startPasskeyLogin), 실패 사유도 뭉뚱그린다.
// "등록되지 않은 기기입니다"와 "서명이 틀렸습니다"를 나눠 주면 그 차이만으로
// 어떤 자격증명이 이 서비스에 있는지 훑을 수 있다.

export async function GET() {
  try {
    return NextResponse.json(await startPasskeyLogin(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

const bodySchema = z.object({ response: z.any() });

export async function POST(req: NextRequest) {
  try {
    const body = bodySchema.parse(await req.json());
    const { userId } = await finishPasskeyLogin(prisma, body.response);
    // 패스키 로그인은 본인 인증을 거치지 않는다 — verifiedAt은 0이고, 그래서 이 세션은
    // 기기 등록 관문(최근성)에서 재인증을 요구받는다. 그것이 맞다: 열쇠로 들어와
    // 열쇠를 또 심는 길을 열어 두면 훔친 기기 하나가 계정을 영구히 장악한다
    await setSessionCookie(userId, { method: 'PASSKEY', verifiedAt: 0 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
