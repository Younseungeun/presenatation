import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { LEGAL_DOCS } from '@/domain/legalDocs';
import { recordConsentEvent } from '@/server/consentService';
import { prisma } from '@/server/db';
import { confirmPaymentIntent } from '@/server/paymentIntentService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

const bodySchema = z.object({
  orderId: z.string().min(1),
  paymentKey: z.string().min(1),
  amount: z.coerce.number().int().positive(),
});

/** 토스페이먼츠 결제창에서 successUrl로 돌아온 뒤 호출 — 실제 승인을 확정한다 */
export async function POST(req: NextRequest) {
  try {
    const buyerId = await requireUserId();
    const { orderId, paymentKey, amount } = bodySchema.parse(await req.json());
    const purchase = await confirmPaymentIntent(prisma, {
      orderId,
      paymentKey,
      clientAmount: amount,
      buyerId,
    });
    await recordConsentEvent(
      prisma,
      buyerId,
      'REFUND_POLICY',
      LEGAL_DOCS.TERMS_OF_SERVICE.version,
      'PURCHASE',
      purchase.reportId,
    );
    return NextResponse.json({ reportId: purchase.reportId });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
