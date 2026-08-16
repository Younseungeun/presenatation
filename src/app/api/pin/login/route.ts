import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { PinError, verifyPinLogin } from '@/server/pinService';
import { setSessionCookie } from '@/server/session';
import { toErrorResponse } from '../../_lib/http';

// 간편 로그인 — 기기 토큰(httpOnly 쿠키)과 비밀번호가 **함께** 맞아야 한다.
//
// 비밀번호만으로는 아무 기기에서나 못 들어온다. 그것이 이 구조의 뼈대다 —
// 새 기기는 무조건 풀 로그인(본인 인증)이다.

const DEVICE_COOKIE = 'rm_device';
const bodySchema = z.object({ pin: z.string().min(1).max(10) });

export async function POST(req: NextRequest) {
  try {
    const store = await cookies();
    const deviceToken = store.get(DEVICE_COOKIE)?.value;
    if (!deviceToken) {
      return NextResponse.json(
        { error: '이 기기에서는 간편 로그인을 쓸 수 없습니다 — 본인 인증으로 로그인해주세요', code: 'UNKNOWN_DEVICE' },
        { status: 403 },
      );
    }
    const { pin } = bodySchema.parse(await req.json());
    const { userId } = await verifyPinLogin(prisma, { deviceToken, pin });

    // 간편 로그인은 본인 인증을 거치지 않았다 — verifiedAt은 0이고, 그래서 이 세션은
    // 자격증명을 심는 관문(패스키·PIN 설정)에서 재인증을 요구받는다
    await setSessionCookie(userId, { method: 'PIN', verifiedAt: 0 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof PinError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 403 });
    }
    return toErrorResponse(e);
  }
}
