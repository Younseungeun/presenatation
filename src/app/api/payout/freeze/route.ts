import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { freezePayouts } from '@/server/payoutAccountService';
import { payoutAccountView } from '@/server/payoutAccountView';
import { isTrustedDevice } from '@/server/pinService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

const bodySchema = z.object({ reason: z.string().max(300).optional() });

/**
 * **정산 동결 — 본인이 건다.**
 *
 * 해제 경로는 여기 없다. 있으면 안 된다: 계정을 쥔 탈취자가 그 경로를 쓴다.
 * 해제는 운영자 콘솔에만 있고(`unfreezePayouts`), 그 비대칭이 이 장치의 전부다.
 *
 * 계좌가 아직 없어도 걸 수 있다 — 탈취자가 **등록하기 전에** 잠그는 것이 가장 이른
 * 방어라서, 서비스가 빈 계좌를 동결 상태로 만들어 둔다.
 *
 * 이미 동결돼 있어도 성공으로 돌려준다. 급한 사람이 버튼을 두 번 누르는 것은 정상이고,
 * 그때 오류를 띄우면 "안 잠긴 건가" 하고 더 불안해진다 (멱등).
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = bodySchema.parse(await req.json().catch(() => ({})));
    await freezePayouts(prisma, { researcherUserId: userId, actor: userId, reason: body.reason });
    const store = await cookies();
    const trusted = await isTrustedDevice(prisma, userId, store.get('rm_device')?.value);
    return NextResponse.json(await payoutAccountView(prisma, userId, trusted));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
