import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/server/db';
import { HttpError, requireUserId, toErrorResponse } from '../../_lib/http';

/**
 * 판매 마감 확인 — 마감된 내 카드를 리더보드에서 내린다.
 * 구매 기록(MY)에는 계속 남는다: 지우는 것이 아니라 "봤다"는 표시다.
 * 되돌리기 API는 두지 않는다 — 확인은 정보를 소비했다는 사실이라 취소할 것이 없고,
 * 카드 자체는 MY 구매 내역에서 언제든 다시 본다.
 */
export async function POST(req: NextRequest) {
  try {
    const buyerId = await requireUserId();
    const body = (await req.json().catch(() => ({}))) as { reportId?: string };
    if (!body.reportId) throw new HttpError(400, 'reportId가 필요합니다');

    const purchase = await prisma.purchase.findUnique({
      where: { reportId_buyerId: { reportId: body.reportId, buyerId } },
      select: { id: true, salesCloseAckAt: true, report: { select: { salesClosedAt: true } } },
    });
    if (!purchase) throw new HttpError(404, '구매 기록이 없습니다');
    if (!purchase.report.salesClosedAt) {
      throw new HttpError(400, '판매가 마감된 카드가 아닙니다');
    }
    if (!purchase.salesCloseAckAt) {
      await prisma.purchase.update({
        where: { id: purchase.id },
        data: { salesCloseAckAt: new Date() },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
