import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { assertRecentlyVerified, AuthGateError } from '@/server/authGates';
import { PinError, setupPin } from '@/server/pinService';
import { getSessionClaims } from '@/server/session';
import { HttpError, toErrorResponse } from '../../_lib/http';

// 간편 비밀번호 설정 — **자격증명을 심는 자리라 패스키 등록과 같은 관문이 걸린다.**
//
// 방금 본인 인증한 세션만 통과한다(최근성). 없으면 새어 나간 세션이 이 기기를
// 신뢰 목록에 올려, 임시 접근이 영구 접근으로 승격된다.
//
// 기기 쿠키 두 개를 심는다:
//   rm_device       httpOnly — 진짜 토큰. JS가 못 읽는다
//   rm_device_hint  읽기 가능 — "이 기기에 간편 로그인이 있다"는 사실만.
//                   로그인 화면이 PIN 입력을 보여줄지 정하는 데 쓴다 (비밀 아님)

const DEVICE_COOKIE = 'rm_device';
const HINT_COOKIE = 'rm_device_hint';
/** 기기 신뢰는 세션(30일)보다 길다 — 만료되면 풀 로그인으로 자연히 돌아간다 */
const DEVICE_MAX_AGE_SEC = 60 * 60 * 24 * 365;

const bodySchema = z.object({
  pin: z.string().min(1).max(10),
  label: z.string().max(40).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const claims = await getSessionClaims();
    if (!claims) throw new HttpError(401, '로그인이 필요합니다');
    assertRecentlyVerified(claims);

    const body = bodySchema.parse(await req.json());
    const store = await cookies();
    const { deviceToken } = await setupPin(prisma, {
      userId: claims.userId,
      pin: body.pin,
      label: body.label ?? '내 기기',
      // 같은 기기에서 다시 설정하면 옛 기록을 지운다
      oldDeviceToken: store.get(DEVICE_COOKIE)?.value ?? null,
    });

    const common = { sameSite: 'lax' as const, path: '/', maxAge: DEVICE_MAX_AGE_SEC,
      secure: process.env.NODE_ENV === 'production' };
    store.set(DEVICE_COOKIE, deviceToken, { ...common, httpOnly: true });
    store.set(HINT_COOKIE, '1', { ...common, httpOnly: false });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof PinError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    if (e instanceof AuthGateError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 403 });
    }
    return toErrorResponse(e);
  }
}
