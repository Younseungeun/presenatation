import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { RESEARCHER_REQUIRED_DOCS } from '@/domain/legalDocs';
import { ensureResearcherProfile } from '@/server/authService';
import { recordConsents } from '@/server/consentService';
import { prisma } from '@/server/db';
import { getSessionUserId } from '@/server/session';
import { HttpError, toErrorResponse } from '../../_lib/http';

const bodySchema = z.object({ agreedResearcher: z.boolean() }).partial();

/** 현재 사용자를 리서처로 전환 (프로필 생성). 리서처 이용계약 동의 필수 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    if (!userId) throw new HttpError(401, '로그인이 필요합니다');
    const body = bodySchema.parse(await req.json().catch(() => ({})));
    if (!body.agreedResearcher) {
      throw new HttpError(400, '리서처 이용계약 동의가 필요합니다');
    }
    const profile = await ensureResearcherProfile(prisma, userId);
    await recordConsents(prisma, userId, RESEARCHER_REQUIRED_DOCS, 'RESEARCHER_ACTIVATION');
    return NextResponse.json({ researcherId: profile.id });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
