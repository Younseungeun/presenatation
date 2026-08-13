import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { assertPurchasable, disciplineCapFor, purchaseReport } from './purchaseService';
import {
  cancelTossPayment,
  confirmTossPayment,
  describeTossPayment,
  pendingDepositReason,
  tossMethodCode,
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
  // 입금이 아직 안 끝난 수단(가상계좌)이면 **구매를 만들기 전에** 되돌린다.
  // 승인 응답이 200이라 여기까지 오지만 돈은 안 들어왔다 — 이유는
  // tossPayments.pendingDepositReason 주석에 있다
  const pending = pendingDepositReason(result);
  if (pending) {
    const rejection = new TossPaymentError(
      `${pending}으로는 결제할 수 없습니다. 예측 카드는 장중 시세에 값이 묶여 있어, 입금이 나중에 이뤄지는 수단으로는 "결제가 승인되는 순간 광고 폭의 절반 이상"이라는 약속을 지킬 수 없습니다. 카드·계좌이체·간편결제로 다시 시도해주세요.`,
      'ASYNC_PAYMENT_NOT_SUPPORTED',
    );
    await voidAfterCapture(prisma, input, rejection, intent.amountKrw);
    throw rejection;
  }

  // 부분 취소가 안 되는 수단(휴대폰·상품권)도 되돌린다 — 실패 시 성과 연동분만
  // 돌려주는 것이 이 상품의 기본 환불이라, 그게 안 되는 수단은 팔 수 없다
  const method = tossMethodCode(result);
  if (method === null) {
    const rejection = new TossPaymentError(
      `${result.method ?? '이 결제 수단'}으로는 결제할 수 없습니다. 예측이 빗나가면 성과 연동분만 돌려드리는데(부분 환불), 이 수단은 부분 취소가 되지 않습니다. 카드·계좌이체·간편결제로 다시 시도해주세요.`,
      'PARTIAL_CANCEL_NOT_SUPPORTED',
    );
    await voidAfterCapture(prisma, input, rejection, intent.amountKrw);
    throw rejection;
  }

  let purchase;
  try {
    purchase = await purchaseReport(
      prisma,
      intent.reportId,
      intent.buyerId,
      now,
      { method },
      describeTossPayment(result),
      input.paymentKey,
    );
  } catch (e) {
    await voidAfterCapture(prisma, input, e, intent.amountKrw);
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
  amountKrw: number,
): Promise<void> {
  const reason = cause instanceof Error ? cause.message : '구매 생성 실패';
  try {
    await cancelTossPayment({
      paymentKey: input.paymentKey,
      cancelReason: `구매가 완료되지 않아 자동 취소: ${reason}`.slice(0, 200),
      // 같은 successUrl이 두 번 열려도(새로고침·뒤로가기) 취소는 한 번이다
      idempotencyKey: `void_${input.orderId}`,
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
      `[P0] 승인 취소 실패 — 수동 취소 필요. orderId=${input.orderId} paymentKey=${input.paymentKey} 금액=${amountKrw} 사유=${reason} 취소실패=${detail}`,
    );
    await notifyOperatorsOfStuckPayment(prisma, {
      orderId: input.orderId,
      paymentKey: input.paymentKey,
      amountKrw,
      reason,
      cancelError: detail,
    });
  }
}

/**
 * 운영자 전원에게 알린다 — **이 알림이 유일한 발견 경로다.**
 *
 * 그래서 알림 하나만 보고 토스 콘솔에서 처리를 끝낼 수 있어야 한다: 콘솔에서 결제를
 * 찾는 열쇠(paymentKey·orderId)와 얼마인지(amountKrw)를 본문에 그대로 적는다.
 * 대시보드 배지를 따로 두지 않는 이유는 이 실패가 연 몇 건 수준의 이례적 장애라,
 * 아무도 열어보지 않는 화면보다 밀어주는 알림이 발견 확률이 높기 때문이다.
 */
async function notifyOperatorsOfStuckPayment(
  prisma: PrismaClient,
  detail: {
    orderId: string;
    paymentKey: string;
    amountKrw: number;
    reason: string;
    cancelError: string;
  },
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
        title: `[긴급] 결제 승인 취소 실패 ${detail.amountKrw.toLocaleString()}원 — 수동 처리 필요`,
        body: [
          `토스 콘솔에서 직접 취소해야 합니다.`,
          `paymentKey: ${detail.paymentKey}`,
          `orderId: ${detail.orderId}`,
          `금액: ${detail.amountKrw.toLocaleString()}원`,
          `구매가 막힌 이유: ${detail.reason}`,
          `자동 취소가 실패한 이유: ${detail.cancelError}`,
        ].join('\n'),
        link: '/admin/settlements',
      })),
    });
  } catch (e) {
    // 알림까지 실패해도 위 console.error와 DB 상태(REQUIRES_MANUAL_VOID)는 남는다
    console.error('운영자 알림 실패:', e);
  }
}
