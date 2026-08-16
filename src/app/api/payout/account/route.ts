import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { payoutAccountView } from '@/server/payoutAccountView';
import { requireUserId, toErrorResponse } from '../../_lib/http';

/**
 * 본인의 정산 계좌 상태 — **본인 것만 본다.**
 *
 * `requireUserId`가 돌려준 id로만 조회한다. 조회 대상을 요청에서 받으면 남의 계좌
 * 상태(등록 여부·동결 여부·뒤 4자리)를 훑을 수 있는 창구가 된다.
 */
export async function GET() {
  try {
    const userId = await requireUserId();
    return NextResponse.json(await payoutAccountView(prisma, userId));
  } catch (e) {
    return toErrorResponse(e);
  }
}
