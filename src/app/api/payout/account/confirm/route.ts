import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { confirmCooldownRelease, PayoutAccountError } from '@/server/payoutAccountService';
import { payoutAccountView } from '@/server/payoutAccountView';
import { isTrustedDevice } from '@/server/pinService';
import { requireUserId, toErrorResponse } from '../../../_lib/http';

// 계좌 변경 유예 즉시 해제 — **평소 기기에서만** (2026-08-16 사용자 확정).
//
// 낯선 기기에서 계좌를 바꾸면 그 화면에 확인 번호가 뜨고, 여기서 그 번호를 받는다.
// 기기 판정은 쿠키(rm_device)로 서버가 직접 한다 — 요청 본문으로 받으면 그 순간
// 이 관문은 "true라고 적으면 열리는 문"이 된다.

const bodySchema = z.object({ code: z.string().min(1).max(10) });

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = bodySchema.parse(await req.json());

    const store = await cookies();
    const trusted = await isTrustedDevice(prisma, userId, store.get('rm_device')?.value);

    await confirmCooldownRelease(
      prisma,
      { researcherUserId: userId, code: body.code, trustedDevice: trusted },
    );
    return NextResponse.json(await payoutAccountView(prisma, userId, trusted));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof PayoutAccountError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
