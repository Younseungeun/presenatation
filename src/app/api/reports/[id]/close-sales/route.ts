import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/server/db';
import { closeSalesByResearcher } from '@/server/salesCloseService';
import { requireUserId, toErrorResponse } from '../../../_lib/http';

/**
 * 리서처 자발 판매 마감 — 본인이 판매를 일찍 닫는다. **회수 불가.**
 *
 * 카드 철회(withdraw)와 다른 것이다:
 *  · 철회는 카드를 무효로 만들어 기존 구매자에게 **전액 환불**된다 (판정 불가)
 *  · 판매 마감은 **판매만** 닫는다 — 카드는 살아서 시한에 정상 판정되고
 *    기존 구매자의 환불 조건은 그대로다
 * 촉매가 지나 논지가 소비됐을 때 필요한 것은 후자다.
 *
 * 소유권 검증은 서비스가 userId로 직접 한다 — requireResearcherId는 프로필 id를 주는데
 * 여기서 대조해야 하는 것은 리포트 작성자의 **userId**다.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    await closeSalesByResearcher(prisma, id, userId);
    return NextResponse.json({ salesClosed: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
