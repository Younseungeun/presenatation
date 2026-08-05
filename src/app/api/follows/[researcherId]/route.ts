import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { FollowError, followResearcher, unfollowResearcher } from '@/server/followService';
import { HttpError, requireUserId, toErrorResponse } from '../../_lib/http';

// 리서처 팔로우 토글 — 로그인 사용자만.
// 두 요청 모두 멱등이다(이미 팔로우/이미 해제여도 성공) — 버튼 연타가 에러로 보이지 않게.

function toResponse(e: unknown): NextResponse {
  if (e instanceof FollowError) return NextResponse.json({ error: e.message }, { status: 400 });
  return toErrorResponse(e);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ researcherId: string }> },
) {
  try {
    const followerId = await requireUserId();
    const { researcherId } = await params;
    if (!researcherId) throw new HttpError(400, '리서처를 지정해 주세요');
    return NextResponse.json(await followResearcher(prisma, followerId, researcherId));
  } catch (e) {
    return toResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ researcherId: string }> },
) {
  try {
    const followerId = await requireUserId();
    const { researcherId } = await params;
    if (!researcherId) throw new HttpError(400, '리서처를 지정해 주세요');
    return NextResponse.json(await unfollowResearcher(prisma, followerId, researcherId));
  } catch (e) {
    return toResponse(e);
  }
}
