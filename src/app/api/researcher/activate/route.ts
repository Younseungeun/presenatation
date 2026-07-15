import { NextResponse } from 'next/server';
import { ensureResearcherProfile } from '@/server/authService';
import { prisma } from '@/server/db';
import { getSessionUserId } from '@/server/session';
import { HttpError, toErrorResponse } from '../../_lib/http';

/** 현재 사용자를 리서처로 전환 (프로필 생성) */
export async function POST() {
  try {
    const userId = await getSessionUserId();
    if (!userId) throw new HttpError(401, '로그인이 필요합니다');
    const profile = await ensureResearcherProfile(prisma, userId);
    return NextResponse.json({ researcherId: profile.id });
  } catch (e) {
    return toErrorResponse(e);
  }
}
