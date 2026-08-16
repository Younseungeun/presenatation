import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { assertNotElevatedRisk, assertRecentlyVerified, AuthGateError } from '@/server/authGates';
import { finishPasskeyRegistration, startPasskeyRegistration } from '@/server/passkeyService';
import { getSessionClaims } from '@/server/session';
import { HttpError, toErrorResponse } from '../../_lib/http';

// 기기 등록 — **뒤에서 받쳐 줄 것이 없는 자리다.**
//
// 여기는 영구적인 로그인 수단을 심는 곳이다. 계좌 변경은 통과해도 48시간 쿨다운이
// 뒤를 받치지만, 열쇠는 심는 순간 곧바로 쓸 수 있다. 그래서 앞에서 두 겹으로 막는다:
//   ① 최근성 — 방금 본인 인증한 세션만 (훔친 세션이 걸어 들어오지 못하게)
//   ② 경로   — 패스키가 있는 계정에 본인 인증으로 들어왔으면 48시간 유예
//
// 등록 대상은 **요청에서 받지 않는다.** 세션이 준 id만 쓴다 — 받게 두면 남의 계정에
// 내 기기를 심는 창구가 된다.

async function gatedUserId(): Promise<string> {
  const claims = await getSessionClaims();
  if (!claims) throw new HttpError(401, '로그인이 필요합니다');
  assertRecentlyVerified(claims);
  await assertNotElevatedRisk(prisma, claims);
  return claims.userId;
}

/** 실패도 관문을 거친다 — 옵션만 받아 두고 마지막에 막으면 사용자가 헛걸음한다 */
export async function GET() {
  try {
    return NextResponse.json(await startPasskeyRegistration(prisma, await gatedUserId()));
  } catch (e) {
    return gateAware(e);
  }
}

const bodySchema = z.object({
  response: z.any(),
  /** 사용자가 알아볼 이름 — 어느 기기를 지울지 고르려면 필요하다 */
  label: z.string().min(1).max(40),
});

export async function POST(req: NextRequest) {
  try {
    const userId = await gatedUserId();
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
    return gateAware(e);
  }
}

/**
 * 관문에 걸린 것은 **코드를 함께 돌려준다.**
 *
 * 화면이 두 경우를 다르게 다뤄야 하기 때문이다 — 재인증으로 지금 풀리는 것과,
 * 기다려야만 풀리는 것. 하나로 뭉뚱그리면 "다시 시도" 버튼이 영영 안 되는 화면이 된다.
 */
function gateAware(e: unknown) {
  if (e instanceof AuthGateError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 403 });
  }
  return toErrorResponse(e);
}
