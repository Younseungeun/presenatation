import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { registerPushSubscription, unregisterPushSubscription } from '@/server/pushService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

// 기기 등록·해지 — **로그인한 사람의 것만.**
//
// 토큰은 그 기기의 주소일 뿐 비밀이 아니지만(가로채도 알림을 대신 받을 뿐 계정은 못 연다),
// 남의 계정에 내 기기를 붙일 수 있으면 **그 사람의 알림을 내가 받게 된다** — 금액·종목이
// 푸시에 안 실리는 이유와 별개로, 애초에 붙일 수 없어야 한다. 그래서 세션에서만 userId를 읽는다.

const bodySchema = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  token: z.string().min(1).max(4000),
  label: z.string().max(80).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = bodySchema.parse(await req.json());
    await registerPushSubscription(prisma, { userId, ...body });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message ?? '요청 형식 오류' }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireUserId();
    const { token } = z.object({ token: z.string().min(1) }).parse(await req.json());
    const removed = await unregisterPushSubscription(prisma, token);
    return NextResponse.json({ removed });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류' }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
