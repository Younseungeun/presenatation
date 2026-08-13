import { NextResponse, type NextRequest } from 'next/server';
import { LEGAL_DOCS } from '@/domain/legalDocs';
import { checkoutCart } from '@/server/cartService';
import { recordConsentEvent } from '@/server/consentService';
import { prisma } from '@/server/db';
import { assertAcceptedPaymentMethod } from '@/server/purchaseService';
import { HttpError, requireUserId, toErrorResponse } from '../../_lib/http';

/**
 * 장바구니 일괄 결제 — 담긴 것 중 결제 가능한 건을 구매하고 에스크로에 보관한다.
 * 단건 구매와 동일하게 환불 규정 동의를 받고, 구매된 리포트마다 동의 이력을 남긴다.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = (await req.json().catch(() => ({}))) as {
      agreedRefund?: boolean;
      paymentMethod?: string;
    };
    if (!body.agreedRefund) {
      throw new HttpError(400, '환불 규정 확인·동의가 필요합니다');
    }

    assertAcceptedPaymentMethod(body.paymentMethod);
    const result = await checkoutCart(prisma, userId, new Date(), { method: 'CARD' });
    for (const reportId of result.purchased) {
      await recordConsentEvent(
        prisma,
        userId,
        'REFUND_POLICY',
        LEGAL_DOCS.TERMS_OF_SERVICE.version,
        'PURCHASE',
        reportId,
      );
    }
    return NextResponse.json(result);
  } catch (e) {
    return toErrorResponse(e);
  }
}
