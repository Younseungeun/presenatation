import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { listLoginDevices, removeLoginDevice } from '@/server/deviceService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

// 로그인 기기 목록·삭제 — **생체와 간편 비밀번호를 한 목록으로 본다.**
//
// 나눠서 보여 주면 잃어버린 폰을 지우려는 사람이 한쪽만 지우고 안심한다.
// 지울 때는 세션 세대를 함께 올려 이미 열려 있는 창까지 닫는다(deviceService).

export async function GET() {
  try {
    return NextResponse.json(await listLoginDevices(prisma, await requireUserId()));
  } catch (e) {
    return toErrorResponse(e);
  }
}

const bodySchema = z.object({
  deviceId: z.string().min(1),
  kind: z.enum(['BIOMETRIC', 'PIN']),
});

export async function DELETE(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const { deviceId, kind } = bodySchema.parse(await req.json());
    // 조건에 userId가 들어간다 — 남의 기기를 지우는 경로를 만들지 않는다
    await removeLoginDevice(prisma, { userId, deviceId, kind });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
