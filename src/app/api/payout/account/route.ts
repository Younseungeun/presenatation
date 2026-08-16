import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { payoutAccountView } from '@/server/payoutAccountView';
import { isTrustedDevice } from '@/server/pinService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

/**
 * 본인의 정산 계좌 상태 — **본인 것만 본다.**
 *
 * `requireUserId`가 돌려준 id로만 조회한다. 조회 대상을 요청에서 받으면 남의 계좌
 * 상태(등록 여부·동결 여부·뒤 4자리)를 훑을 수 있는 창구가 된다.
 *
 * 기기 구분을 함께 넘긴다 — 유예 확인 번호는 낯선 기기에만 보이고,
 * 입력은 평소 기기에서만 받는다 (payoutAccountView 주석).
 */
export async function GET() {
  try {
    const userId = await requireUserId();
    const store = await cookies();
    const trusted = await isTrustedDevice(prisma, userId, store.get('rm_device')?.value);
    return NextResponse.json(await payoutAccountView(prisma, userId, trusted));
  } catch (e) {
    return toErrorResponse(e);
  }
}
