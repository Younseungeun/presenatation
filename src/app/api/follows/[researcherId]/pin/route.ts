import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { FollowError, setResearcherPinned } from '@/server/followService';
import { HttpError, requireUserId, toErrorResponse } from '../../../_lib/http';

// 리더보드 팔로우 섹션 고정 토글 — 로그인 사용자만, 자기 팔로우 목록 안에서만.

const bodySchema = z.object({ pinned: z.boolean() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ researcherId: string }> },
) {
  try {
    const followerId = await requireUserId();
    const { researcherId } = await params;
    if (!researcherId) throw new HttpError(400, '리서처를 지정해 주세요');
    const { pinned } = bodySchema.parse(await req.json());
    return NextResponse.json(
      await setResearcherPinned(prisma, followerId, researcherId, pinned),
    );
  } catch (e) {
    if (e instanceof FollowError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message ?? '입력 형식 오류' }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
