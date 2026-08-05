import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { requireUserId, toErrorResponse } from '../../_lib/http';

// 내 프로필 수정 — 지금은 필명 하나다.
// 필명은 팔로우 목록·리포트·리더보드에 나가는 표시 이름이라 본인만 고칠 수 있다.
// (이름·휴대폰 같은 본인 인증 정보는 CI에 묶여 있어 여기서 바꿀 수 없다)

const bodySchema = z.object({
  penName: z.string().max(30, '필명은 30자까지 쓸 수 있습니다').nullable(),
});

export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const { penName } = bodySchema.parse(await req.json());
    const trimmed = penName?.trim() || null;
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { penName: trimmed },
      select: { penName: true },
    });
    return NextResponse.json(updated);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message ?? '입력 형식 오류' }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
