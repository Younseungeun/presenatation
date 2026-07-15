import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAndSignIn } from '@/server/authService';
import { prisma } from '@/server/db';
import { StubIdentityProvider } from '@/server/identityProvider';
import { setSessionCookie } from '@/server/session';
import { toErrorResponse } from '../../_lib/http';

const provider = new StubIdentityProvider();

const bodySchema = z.object({
  name: z.string().min(1).max(50),
  phone: z.string().min(10).max(20),
  penName: z.string().max(30).optional(),
});

/** 본인 인증 → 로그인(세션 발급). 같은 CI는 항상 같은 계정으로 매핑된다. */
export async function POST(req: NextRequest) {
  try {
    const body = bodySchema.parse(await req.json());
    const result = await verifyAndSignIn(prisma, provider, body);
    await setSessionCookie(result.userId);
    return NextResponse.json({ userId: result.userId, isNewUser: result.isNewUser });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
