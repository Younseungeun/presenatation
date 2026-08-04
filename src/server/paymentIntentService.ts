import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { assertPurchasable, purchaseReport, type PaymentMethod } from './purchaseService';
import { confirmTossPayment, describeTossPayment, TossPaymentError } from './tossPayments';

// 토스페이먼츠 결제창을 띄우기 전 "결제 의도"를 서버에 먼저 기록하고,
// 결제창이 돌아온 뒤(successUrl) 그 기록과 PG 응답을 대조해 승인한다.
// 토스페이먼츠 가이드가 명시하는 절차: "결제를 요청하기 전에 orderId와 amount를
// 서버에 임시로 저장하세요. 결제 요청과 승인 사이에 데이터 무결성을 확인할 때 필요해요."

export interface PreparedPayment {
  orderId: string;
  orderName: string;
  amountKrw: number;
}

export async function createPaymentIntent(
  prisma: PrismaClient,
  input: { reportId: string; buyerId: string },
  now = new Date(),
): Promise<PreparedPayment> {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: input.reportId },
    include: { researcher: true, predictionCard: true },
  });
  assertPurchasable(report, input.buyerId, now);

  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: input.buyerId } });
  if (!buyer.identityVerified) {
    throw new Error('본인 인증 후 구매할 수 있습니다');
  }
  const already = await prisma.purchase.findUnique({
    where: { reportId_buyerId: { reportId: input.reportId, buyerId: input.buyerId } },
  });
  if (already) {
    throw new Error('이미 구매한 리포트입니다');
  }

  // orderId에 reportId를 심어둔다 — 성공/실패 리다이렉트 화면이 별도 조회 없이
  // "어느 리포트로 돌아갈지" 알 수 있게(토스페이먼츠 orderId 문자 제약: 영문·숫자·-_=, 6~64자)
  const orderId = `pi_${input.reportId}_${randomBytes(4).toString('hex')}`;

  await prisma.paymentIntent.create({
    data: {
      orderId,
      buyerId: input.buyerId,
      reportId: input.reportId,
      amountKrw: report.priceKrw,
      status: 'PENDING',
    },
  });

  return { orderId, orderName: report.title.slice(0, 100), amountKrw: report.priceKrw };
}

export interface ConfirmInput {
  orderId: string;
  paymentKey: string;
  /** successUrl 쿼리로 돌아온 금액 — intent에 저장된 금액과 다르면 조작 의심 */
  clientAmount: number;
  buyerId: string;
}

/**
 * 결제창에서 돌아온 뒤 실제 승인을 확정한다.
 * 이미 CONFIRMED된 orderId로 다시 호출되면(중복 콜백) 새로 승인하지 않고 기존 구매를 반환한다.
 */
export async function confirmPaymentIntent(
  prisma: PrismaClient,
  input: ConfirmInput,
  now = new Date(),
) {
  const intent = await prisma.paymentIntent.findUnique({ where: { orderId: input.orderId } });
  if (!intent) {
    throw new TossPaymentError('결제 정보를 찾을 수 없습니다');
  }
  if (intent.buyerId !== input.buyerId) {
    throw new TossPaymentError('본인의 결제가 아닙니다');
  }
  if (intent.status === 'CONFIRMED') {
    const existing = await prisma.purchase.findUnique({
      where: { reportId_buyerId: { reportId: intent.reportId, buyerId: intent.buyerId } },
    });
    if (existing) return existing;
  }
  // 클라이언트가 돌려준 금액과 우리가 서버에 미리 저장해둔 금액을 대조 —
  // 이 값이 아니라 intent.amountKrw(서버 신뢰 값)로 토스에 승인 요청한다
  if (intent.amountKrw !== input.clientAmount) {
    await prisma.paymentIntent.update({ where: { orderId: input.orderId }, data: { status: 'FAILED' } });
    throw new TossPaymentError('결제 금액이 일치하지 않습니다');
  }

  const result = await confirmTossPayment({
    paymentKey: input.paymentKey,
    orderId: input.orderId,
    amount: intent.amountKrw,
  });

  const method: PaymentMethod = result.virtualAccount ? 'VBANK' : 'CARD';
  const purchase = await purchaseReport(
    prisma,
    intent.reportId,
    intent.buyerId,
    now,
    { method },
    describeTossPayment(result),
  );

  await prisma.paymentIntent.update({ where: { orderId: input.orderId }, data: { status: 'CONFIRMED' } });
  return purchase;
}
