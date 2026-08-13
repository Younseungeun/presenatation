import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import {
  assertPurchasable,
  disciplineCapFor,
  purchaseReport,
  type PaymentMethod,
} from './purchaseService';
import {
  cancelTossPayment,
  confirmTossPayment,
  describeTossPayment,
  TossPaymentError,
} from './tossPayments';

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
  assertPurchasable(report, input.buyerId, now, await disciplineCapFor(prisma, report, now));

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

  // ── 여기서부터 **돈이 이미 빠졌다.** 아래가 실패하면 반드시 되돌려야 한다 ──
  //
  // purchaseReport는 구매 가능 여부를 **다시** 검사한다(판매 기간·판정 여부·규율 상한·
  // 실시간 시세). 사용자가 결제창에 머무는 수 초~수 분 사이에 그중 하나가 바뀌면
  // 여기서 던진다. 되돌리지 않으면 **돈은 빠졌는데 구매 행이 없는 상태**가 남고,
  // 결제 의도는 PENDING이라 아무도 그 건을 찾지 못한다.
  //
  // 재검증을 없애는 선택지는 쓰지 않는다: 이미 판정된 카드가 팔리면 정산이 꼬이고,
  // 규율 상한이 내려간 카드가 팔리면 처분이 이름만 남는다. **잘못 파는 것보다
  // 승인 취소가 낫다.**
  const method: PaymentMethod = result.virtualAccount ? 'VBANK' : 'CARD';
  let purchase;
  try {
    purchase = await purchaseReport(
      prisma,
      intent.reportId,
      intent.buyerId,
      now,
      { method },
      describeTossPayment(result),
    );
  } catch (e) {
    await voidAfterCapture(prisma, input, e);
    throw e; // 원래 사유를 그대로 올린다 — 구매자에게는 왜 막혔는지가 답이다
  }

  await prisma.paymentIntent.update({ where: { orderId: input.orderId }, data: { status: 'CONFIRMED' } });
  return purchase;
}

/**
 * 보상 트랜잭션 — 승인된 결제를 되돌린다.
 *
 * 취소마저 실패하면 **REQUIRES_MANUAL_VOID로 남긴다.** 이 상태는 "PG에는 돈이 잡혀
 * 있는데 우리 쪽에는 판 것이 없다"는 뜻이라, 사람이 토스 콘솔에서 직접 취소해야 한다.
 * 조용히 삼키면 그 돈은 아무도 모르게 사라진다 — 그래서 실패를 상태로 남기고
 * 운영자에게 알린다.
 */
async function voidAfterCapture(
  prisma: PrismaClient,
  input: ConfirmInput,
  cause: unknown,
): Promise<void> {
  const reason = cause instanceof Error ? cause.message : '구매 생성 실패';
  try {
    await cancelTossPayment({
      paymentKey: input.paymentKey,
      cancelReason: `구매 생성 실패로 자동 취소: ${reason}`.slice(0, 200),
    });
    await prisma.paymentIntent.update({
      where: { orderId: input.orderId },
      data: { status: 'CANCELLED' },
    });
  } catch (cancelError) {
    await prisma.paymentIntent.update({
      where: { orderId: input.orderId },
      data: { status: 'REQUIRES_MANUAL_VOID' },
    });
    const detail = cancelError instanceof Error ? cancelError.message : String(cancelError);
    console.error(
      `[P0] 승인 취소 실패 — 수동 취소 필요. orderId=${input.orderId} paymentKey=${input.paymentKey} 사유=${reason} 취소실패=${detail}`,
    );
    await notifyOperatorsOfStuckPayment(prisma, input.orderId, reason, detail);
  }
}

/** 운영자 전원에게 알린다 — 이 알림이 유일한 발견 경로다 */
async function notifyOperatorsOfStuckPayment(
  prisma: PrismaClient,
  orderId: string,
  reason: string,
  cancelError: string,
): Promise<void> {
  try {
    const operators = await prisma.user.findMany({
      where: { role: 'OPERATOR' },
      select: { id: true },
    });
    if (operators.length === 0) return;
    await prisma.notification.createMany({
      data: operators.map((o) => ({
        userId: o.id,
        type: 'OPS_ALERT',
        title: '[긴급] 결제 승인 취소 실패 — 수동 처리 필요',
        body: `주문 ${orderId}: 승인은 됐으나 구매 생성이 실패했고(${reason}) 자동 취소도 실패했습니다(${cancelError}). 토스 콘솔에서 직접 취소해야 합니다.`,
        link: '/admin/settlement',
      })),
    });
  } catch (e) {
    // 알림까지 실패해도 위 console.error와 DB 상태(REQUIRES_MANUAL_VOID)는 남는다
    console.error('운영자 알림 실패:', e);
  }
}
