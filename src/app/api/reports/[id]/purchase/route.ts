import { NextResponse, type NextRequest } from 'next/server';
import { LEGAL_DOCS } from '@/domain/legalDocs';
import { recordConsentEvent } from '@/server/consentService';
import { prisma } from '@/server/db';
import { assertAcceptedPaymentMethod, purchaseReport } from '@/server/purchaseService';
import { HttpError, requireUserId, toErrorResponse } from '../../../_lib/http';

/**
 * 리포트 구매 — 결제(PG 스텁) 후 에스크로 보관.
 * 판정 결과에 따라 배치가 정산한다: 적중 → 리서처 정산 / 실패 → 현금 환불 / 불가 → 전액 환불
 * 구매 시 환불 규정 고지·동의를 받고 이력을 남긴다 (전자상거래법 고지).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const buyerId = await requireUserId();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      agreedRefund?: boolean;
      paymentMethod?: string;
    };
    if (!body.agreedRefund) {
      throw new HttpError(400, '환불 규정 확인·동의가 필요합니다');
    }
    assertAcceptedPaymentMethod(body.paymentMethod);
    const purchase = await purchaseReport(prisma, id, buyerId, new Date(), { method: 'CARD' });
    // 구매 시점 환불 규정 동의 이력 (이용약관 버전 기준, 대상 리포트 기록)
    await recordConsentEvent(
      prisma,
      buyerId,
      'REFUND_POLICY',
      LEGAL_DOCS.TERMS_OF_SERVICE.version,
      'PURCHASE',
      id,
    );
    return NextResponse.json(purchase, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
