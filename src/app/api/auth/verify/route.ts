import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { signUpAndSignIn } from '@/server/authService';
import { prisma } from '@/server/db';
import { createDefaultIdentityProvider } from '@/server/identityProvider';
import { setSessionCookie } from '@/server/session';
import { toErrorResponse } from '../../_lib/http';

const provider = createDefaultIdentityProvider();

const bodySchema = z.object({
  name: z.string().min(1).max(50),
  phone: z.string().min(10).max(20),
  penName: z.string().max(30).optional(),
  /** 필수 약관 동의 (이용약관·개인정보처리방침) */
  agreedTerms: z.boolean(),
  /**
   * 가입 갈래 — 단순 이용자(USER)로 시작할지 리서처(RESEARCHER)로 시작할지.
   * 생략하면 USER (기존 클라이언트 호환).
   */
  accountType: z.enum(['USER', 'RESEARCHER']).default('USER'),
  /** 리서처로 시작할 때만 필요한 리서처 이용계약 동의 */
  agreedResearcher: z.boolean().optional(),
});

/**
 * 본인 인증 → 로그인(세션 발급). 같은 CI는 항상 같은 계정으로 매핑된다.
 * 리서처로 시작하면 계정 생성과 함께 리서처 프로필까지 만든다 —
 * 나중에 MY에서 전환하는 경로(/api/researcher/activate)는 그대로 남는다.
 */
export async function POST(req: NextRequest) {
  try {
    const body = bodySchema.parse(await req.json());
    if (!body.agreedTerms) {
      return NextResponse.json({ error: '이용약관·개인정보처리방침 동의가 필요합니다' }, { status: 400 });
    }
    if (body.accountType === 'RESEARCHER' && !body.agreedResearcher) {
      return NextResponse.json({ error: '리서처 이용계약 동의가 필요합니다' }, { status: 400 });
    }

    const result = await signUpAndSignIn(prisma, provider, body);
    await setSessionCookie(result.userId);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
