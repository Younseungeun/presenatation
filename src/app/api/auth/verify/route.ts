import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { PEN_NAME_MAX } from '@/domain/penName';
import { AuthError, signUpAndSignIn } from '@/server/authService';
import { prisma } from '@/server/db';
import { createDefaultIdentityProvider } from '@/server/identityProvider';
import { notifyElevatedRiskLogin } from '@/server/authGates';
import { isTrustedDevice } from '@/server/pinService';
import { setSessionCookie } from '@/server/session';
import { toErrorResponse } from '../../_lib/http';

const provider = createDefaultIdentityProvider();

const bodySchema = z.object({
  name: z.string().min(1).max(50),
  phone: z.string().min(10).max(20),
  /**
   * 앱에서 표시될 이름 — **새 계정에는 필수**다 (authService가 막는다).
   *
   * 여기서 required로 두지 않는 이유: 이 라우트는 가입과 재로그인을 함께 받는데,
   * 이미 이름이 있는 사람에게 로그인할 때마다 이름을 다시 적으라고 할 수 없다.
   * "새 계정이면 필수"는 기존 계정을 아는 쪽(authService)만 판단할 수 있다.
   */
  penName: z.string().max(PEN_NAME_MAX).optional(),
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
    // **방금 본인 인증을 통과했다는 사실을 세션에 남긴다.** 패스키 등록 관문이
    // 이 시각을 보고 "지금 화면 앞의 사람이 방금 인증한 그 사람"인지 판단한다
    await setSessionCookie(result.userId, { method: 'IDENTITY', verifiedAt: Date.now() });

    // 패스키가 있는데 **본인 인증으로** 들어왔다면 평소 경로가 아니다 — 유심을 가로챈
    // 공격자가 고르는 길이 이쪽이라, 본인에게 알리고 48시간 동안 열쇠를 못 심게 한다
    await notifyElevatedRiskLogin(prisma, result.userId);

    // 이 기기에 간편 비밀번호가 없으면 설정으로 보낸다 — 간편 비밀번호는 필수다
    // (2026-08-16 사용자 확정). 기기마다다: 새 기기의 풀 로그인 뒤에는 그 기기의
    // 간편 로그인을 만들어야 다음부터 휴면-깨우기로 들어온다
    const store = await cookies();
    const pinSetupRequired = !(await isTrustedDevice(
      prisma,
      result.userId,
      store.get('rm_device')?.value,
    ));
    // 관리자 신원이면 첫 화면이 운영 대시보드다 (2026-08-17 사용자 확정 구조).
    // 방금 verifyAndSignIn이 신원으로 승격까지 마쳤으므로 여기선 role만 읽으면 된다
    const me = await prisma.user.findUnique({
      where: { id: result.userId },
      select: { role: true },
    });
    return NextResponse.json({ ...result, pinSetupRequired, operator: me?.role === 'OPERATOR' });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
