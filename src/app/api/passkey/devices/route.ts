import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { listPasskeys, removePasskey } from '@/server/passkeyService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

// 등록된 기기 목록·삭제 — 본인 것만 본다.

export async function GET() {
  try {
    return NextResponse.json(await listPasskeys(prisma, await requireUserId()));
  } catch (e) {
    return toErrorResponse(e);
  }
}

const bodySchema = z.object({ passkeyId: z.string().min(1) });

export async function DELETE(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const { passkeyId } = bodySchema.parse(await req.json());
    // 조건에 userId가 들어간다 — 남의 기기를 지우는 경로를 만들지 않는다
    await removePasskey(prisma, { userId, passkeyId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
