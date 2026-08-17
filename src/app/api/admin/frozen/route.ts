import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import {
  listFrozenAccounts,
  PayoutAccountError,
  unfreezePayouts,
} from '@/server/payoutAccountService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 정산 동결 관리 — **푸는 쪽의 유일한 창구** (거는 쪽은 본인의 /settings/payout).
//
// 해제는 여기서도 혼자 못 한다: 승인이 없으면 서비스가 요청을 대신 올리고 멈추고,
// 다른 운영자가 /admin/approvals에서 승인해야 다음 실행이 통과한다.

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json({ frozen: await listFrozenAccounts(prisma) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

const bodySchema = z.object({
  researcherUserId: z.string().min(1),
  /** 무엇을 확인하고 푸는가 — 승인자가 읽을 사유가 된다 */
  reason: z.string().min(1).max(300),
  /** 생체 재확인 표 (1인 운영 모드) — 생체를 통과한 화면이 방금 받은 1회용 값 */
  recheckToken: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    await unfreezePayouts(prisma, { ...body, operatorUserId });
    return NextResponse.json({ frozen: await listFrozenAccounts(prisma) });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof PayoutAccountError) {
      // APPROVAL_PENDING은 실패가 아니라 절차의 절반 — 화면이 구분해 그리도록 코드를 싣는다
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
