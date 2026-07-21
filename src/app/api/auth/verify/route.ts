import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { SIGNUP_REQUIRED_DOCS } from '@/domain/legalDocs';
import { verifyAndSignIn } from '@/server/authService';
import { recordConsents } from '@/server/consentService';
import { prisma } from '@/server/db';
import { StubIdentityProvider } from '@/server/identityProvider';
import { setSessionCookie } from '@/server/session';
import { toErrorResponse } from '../../_lib/http';

const provider = new StubIdentityProvider();

const bodySchema = z.object({
  name: z.string().min(1).max(50),
  phone: z.string().min(10).max(20),
  penName: z.string().max(30).optional(),
  /** 필수 약관 동의 (이용약관·개인정보처리방침) */
  agreedTerms: z.boolean(),
});

/** 본인 인증 → 로그인(세션 발급). 같은 CI는 항상 같은 계정으로 매핑된다. */
export async function POST(req: NextRequest) {
  try {
    const body = bodySchema.parse(await req.json());
    if (!body.agreedTerms) {
      return NextResponse.json({ error: '이용약관·개인정보처리방침 동의가 필요합니다' }, { status: 400 });
    }
    const result = await verifyAndSignIn(prisma, provider, body);
    // 현재 버전 필수 약관 동의 이력 기록 (같은 버전 중복은 기록하지 않음)
    await recordConsents(prisma, result.userId, SIGNUP_REQUIRED_DOCS, 'SIGNUP');
    await setSessionCookie(result.userId);
    return NextResponse.json({ userId: result.userId, isNewUser: result.isNewUser });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
