import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { createDefaultIdentityProvider } from '@/server/identityProvider';
import { registerPayoutAccount } from '@/server/payoutAccountService';
import { payoutAccountView } from '@/server/payoutAccountView';
import { isTrustedDevice } from '@/server/pinService';
import { requireUserId, toErrorResponse } from '../../../_lib/http';

// 정산 계좌 등록·변경 — **돈의 방향이 바뀌는 유일한 창구다.**
//
// 여기만 본인 인증을 다시 받는다. 평소 로그인은 생체(패스키)로 끝나지만, 이 요청은
// **생체로는 부족하다** — 생체는 "같은 기기"를 증명할 뿐 **이름을 모르고**, 은행이
// 돌려주는 예금주명과 맞춰볼 상대편이 없기 때문이다.
//
// 이름·번호를 여기서 받아 그 자리에서 인증하고, 그 응답의 CI가 계정 주인의 것인지
// 확인한다. 이름은 **사용자가 적는 것이 아니라 인증 응답에서 나온다** — 적게 하면
// 양쪽을 다 본인이 쓰는 것이라 대조가 성립하지 않는다.

const bodySchema = z.object({
  bankCode: z.string().min(1).max(10),
  accountNumber: z.string().min(8).max(30),
  /** 본인 인증 입력 — 계좌번호와 함께 받아 그 자리에서 인증한다 */
  name: z.string().min(1).max(20),
  phone: z.string().min(9).max(20),
});

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = bodySchema.parse(await req.json());

    // 실패하면 여기서 끝난다 — 계좌는 손도 대지 않는다
    const identity = await createDefaultIdentityProvider().verify({
      name: body.name,
      phone: body.phone,
    });

    // **평소 로그인 기기인가** — 간편 로그인이 사는 기기의 토큰(httpOnly 쿠키)이
    // 이 계정의 것인지 본다. 맞으면 쿨다운·고지 없이 등록되고, 낯선 기기면
    // 48시간 대기 + "다른 기기에서 변경됨" 고지가 붙는다 (payoutAccountService ②).
    // 쿠키는 위조할 수 없다(서버는 해시만 보관, 토큰은 풀 로그인 때만 발급)
    const store = await cookies();
    const trustedDevice = await isTrustedDevice(prisma, userId, store.get('rm_device')?.value);

    await registerPayoutAccount(prisma, {
      researcherUserId: userId,
      bankCode: body.bankCode,
      accountNumber: body.accountNumber,
      identity: { ci: identity.ci, name: identity.name },
      trustedDevice,
      actor: userId,
    });
    return NextResponse.json(await payoutAccountView(prisma, userId), { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
