import type { PrismaClient } from '@prisma/client';
import { cancelViaPg } from './settlementOpsService';

// CS 환불 = **거래 자체의 무효화(void)**. 판정이 만든 환불과 다른 일이다.
//
// 판정 환불("예측이 빗나가 성과 연동분을 돌려준다")은 상품이 약속대로 작동한 결과라
// 구매자는 리포트를 읽고 결과를 기다린 셈이고, 본문은 계속 볼 수 있어야 한다.
// CS 환불("실수로 결제했어요", "두 번 눌렀어요")은 **산 적 없는 것으로 되돌리는** 일이다.
//
// 그래서 escrowStatus를 REFUNDED가 아니라 **CANCELLED**로 둔다. 같은 값을 쓰면
// 결제 → 열람 → 즉시 CS환불이 공짜 열람 경로가 된다.
//
// **판정 후에는 이 길을 쓰지 않는다.** 판정이 나면 정산·점수·환불이 이미 계산됐고,
// 그걸 되돌리는 것은 판정 되돌리기(judgmentRevertService)의 일이다. 여기서 손대면
// 카드의 판정은 남은 채 구매만 사라져 정산 합계가 어긋난다.

export class PurchaseVoidError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'ALREADY_JUDGED'
      | 'NOT_VOIDABLE'
      | 'NO_PAYMENT_KEY'
      | 'IN_FLIGHT',
    message: string,
  ) {
    super(message);
    this.name = 'PurchaseVoidError';
  }
}

export interface VoidInput {
  purchaseId: string;
  operatorUserId: string;
  /** 토스 콘솔·구매자 카드 명세서에 남는다 — 사람이 읽을 사유 */
  reason: string;
}

export interface VoidResult {
  purchaseId: string;
  buyerId: string;
  amountKrw: number;
  attemptId: string;
}

/**
 * 구매를 무효화하고 전액 환불한다 (운영자 전용).
 *
 * 전액만 다룬다 — CS 환불에 부분 취소가 필요한 상황("절반만 돌려주세요")은 상품 구조상
 * 존재하지 않고, 열려 있으면 실수로 잘못된 금액이 나가는 통로가 될 뿐이다.
 */
export async function voidPurchase(
  prisma: PrismaClient,
  input: VoidInput,
  now = new Date(),
): Promise<VoidResult> {
  const purchase = await prisma.purchase.findUnique({
    where: { id: input.purchaseId },
    include: {
      settlement: true,
      report: { select: { id: true, predictionCard: { select: { judgment: true } } } },
      refundAttempts: true,
    },
  });
  if (!purchase) {
    throw new PurchaseVoidError('NOT_FOUND', `구매를 찾을 수 없습니다: ${input.purchaseId}`);
  }

  // 판정이 났으면 이 길이 아니다 — 정산·점수가 이미 계산돼 있다
  if (purchase.report.predictionCard?.judgment || purchase.settlement) {
    throw new PurchaseVoidError(
      'ALREADY_JUDGED',
      '이미 판정된 카드의 구매입니다. 판정을 되돌리려면 npm run judgment:revert 를 쓰세요 — ' +
        '여기서 구매만 지우면 카드의 판정은 남은 채 정산 합계가 어긋납니다.',
    );
  }
  if (purchase.escrowStatus !== 'HELD' && purchase.escrowStatus !== 'DISPUTED') {
    throw new PurchaseVoidError(
      'NOT_VOIDABLE',
      `무효화할 수 없는 상태입니다: ${purchase.escrowStatus}`,
    );
  }
  if (!purchase.paymentKey) {
    throw new PurchaseVoidError(
      'NO_PAYMENT_KEY',
      'PG 결제 키가 없는 구매입니다(스텁·옛 구매). 계좌이체로 환불한 뒤 기록해야 합니다.',
    );
  }
  // 끝나지 않은 시도가 있으면 새로 만들지 않는다 — 새 시도는 **새 멱등키**로 나가
  // 두 번 빠질 수 있다. 먼저 그 시도를 확정해야 한다
  const inFlight = purchase.refundAttempts.filter((a) => a.status === 'PENDING');
  if (inFlight.length > 0) {
    throw new PurchaseVoidError(
      'IN_FLIGHT',
      `끝나지 않은 환불 시도가 있습니다 (${inFlight.map((a) => a.id).join(', ')}). ` +
        '나갔는지 확인되기 전에 새로 만들면 두 번 빠집니다.',
    );
  }

  // **시도 행을 먼저 만든다** — 그 id가 곧 멱등키다. 호출 전에 만들어야
  // 응답을 못 받았을 때 같은 키로 이어받을 수 있다 (RefundAttempt 주석)
  const attempt = await prisma.refundAttempt.create({
    data: {
      type: 'CS_CANCEL',
      purchaseId: purchase.id,
      amountKrw: purchase.amountKrw,
      method: 'PG_CANCEL',
      operatorId: input.operatorUserId,
      createdAt: now,
    },
  });

  await cancelViaPg(
    prisma,
    attempt,
    purchase.paymentKey,
    `인투빌 구매 취소 — ${input.reason}`.slice(0, 200),
    now,
  );

  await prisma.$transaction([
    prisma.refundAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', finishedAt: now },
    }),
    // **CANCELLED가 열람을 닫는다** (reportQueries의 열람 판정이 이 값을 본다).
    // 동시 실행 대비로 조건을 다시 건다 — 두 운영자가 같은 건을 눌러도 한 번만 바뀐다
    prisma.purchase.updateMany({
      where: { id: purchase.id, escrowStatus: { in: ['HELD', 'DISPUTED'] } },
      data: { escrowStatus: 'CANCELLED' },
    }),
    prisma.notification.create({
      data: {
        userId: purchase.buyerId,
        type: 'REFUND_EXECUTED',
        title: `구매 취소 — ${purchase.amountKrw.toLocaleString()}원 환불`,
        body:
          `${input.reason}\n결제 취소가 접수되었습니다. 카드사 사정에 따라 3~5영업일 내 환불됩니다.\n` +
          '취소된 구매라 해당 리포트는 더 이상 열람할 수 없습니다.',
        link: `/report/${purchase.report.id}`,
        createdAt: now,
      },
    }),
  ]);

  return {
    purchaseId: purchase.id,
    buyerId: purchase.buyerId,
    amountKrw: purchase.amountKrw,
    attemptId: attempt.id,
  };
}

/**
 * 끝나지 않은 CS 환불 시도를 **같은 키로 이어받는다.**
 *
 * PG 응답을 못 받으면 나갔는지 알 수 없어 시도가 PENDING으로 남는다. 새로 만들면
 * 새 멱등키라 두 번 빠지므로, 그 시도 id를 그대로 다시 쓴다 — 이미 나갔으면 토스가
 * 원래 응답을 돌려주고, 안 나갔으면 그때 나간다. 어느 쪽이든 한 번이다.
 */
export async function retryCsRefund(
  prisma: PrismaClient,
  attemptId: string,
  now = new Date(),
): Promise<void> {
  const attempt = await prisma.refundAttempt.findUnique({
    where: { id: attemptId },
    include: { purchase: { include: { report: { select: { id: true } } } } },
  });
  if (!attempt || attempt.type !== 'CS_CANCEL' || !attempt.purchase) {
    throw new PurchaseVoidError('NOT_FOUND', `CS 환불 시도를 찾을 수 없습니다: ${attemptId}`);
  }
  if (attempt.status !== 'PENDING') {
    throw new PurchaseVoidError('NOT_VOIDABLE', `이미 끝난 시도입니다 (${attempt.status})`);
  }

  await cancelViaPg(prisma, attempt, attempt.purchase.paymentKey!, '인투빌 구매 취소(재시도)', now);
  await prisma.$transaction([
    prisma.refundAttempt.update({
      where: { id: attempt.id },
      data: { status: 'SUCCEEDED', finishedAt: now },
    }),
    prisma.purchase.updateMany({
      where: { id: attempt.purchase.id, escrowStatus: { in: ['HELD', 'DISPUTED'] } },
      data: { escrowStatus: 'CANCELLED' },
    }),
  ]);
}

// ── 차지백(결제 분쟁) ────────────────────────────────────────
//
// 차지백은 **우리가 시작하지 않은 사건**이다. 구매자가 카드사에 이의를 걸면 PG 장부에서
// 돈이 빠지는데 우리는 대조 배치로만 안다(domain/reconciliation.ts).
//
// 그때 카드 전체를 멈추면 안 된다 — 분쟁은 구매자 한 사람의 일이고 리포트의 판정이나
// 다른 구매자의 에스크로와 무관하다. 판정은 그대로 나고, **그 구매만** 정산에서 빠진다
// (판정 배치가 escrowStatus: 'HELD'만 가져가므로 값을 바꾸는 것으로 충분하다).

export async function markDisputed(
  prisma: PrismaClient,
  purchaseId: string,
  now = new Date(),
): Promise<void> {
  const { count } = await prisma.purchase.updateMany({
    where: { id: purchaseId, escrowStatus: 'HELD' },
    data: { escrowStatus: 'DISPUTED' },
  });
  if (count === 0) {
    throw new PurchaseVoidError(
      'NOT_VOIDABLE',
      '분쟁으로 표시할 수 없는 구매입니다 (이미 정산·환불·취소됐거나 없는 건).',
    );
  }
  const purchase = await prisma.purchase.findUniqueOrThrow({
    where: { id: purchaseId },
    include: { report: { select: { id: true, researcher: { select: { userId: true } } } } },
  });
  // **리서처에게 알린다.** 조용히 정산액만 줄이면 "플랫폼이 떼어먹었다"거나 "정산에
  // 버그가 있다"고 읽힌다 — 실제로는 우리도 못 받은 돈인데 설명할 기회를 잃는다
  await prisma.notification.create({
    data: {
      userId: purchase.report.researcher.userId,
      type: 'OPS_ALERT',
      title: '결제 분쟁 발생 — 해당 건 지급 보류',
      body:
        `구매 1건(${purchase.amountKrw.toLocaleString()}원)에 결제 분쟁이 접수되어 정산에서 보류됩니다.\n` +
        '분쟁이 플랫폼 쪽으로 확정되면 그때 추가 정산됩니다. 다른 구매 건과 판정에는 영향이 없습니다.',
      link: `/report/${purchase.report.id}`,
      createdAt: now,
    },
  });
}

/**
 * 분쟁 확정 — **되돌아오는 길이 없으면 DISPUTED는 블랙홀이다.**
 *
 * `WON`(우리가 이겼다: 돈이 남는다) → HELD로 되돌린다. 카드가 이미 판정됐다면
 * 그 판정에는 이 구매의 정산이 없으므로, 판정 뒤에 이긴 건은 운영자가 정산을 따로
 * 만들어야 한다 — 그 사실을 결과로 알린다(조용히 넘기면 리서처 돈이 사라진다).
 * `LOST`(구매자가 이겼다: 돈이 나갔다) → CANCELLED. 이미 PG가 회수했으므로 우리가
 * 부를 취소는 없다 — 장부만 현실에 맞춘다.
 */
export async function resolveDispute(
  prisma: PrismaClient,
  input: { purchaseId: string; resolution: 'WON' | 'LOST'; operatorUserId: string },
  now = new Date(),
): Promise<{ settlementNeeded: boolean }> {
  const purchase = await prisma.purchase.findUnique({
    where: { id: input.purchaseId },
    include: { report: { select: { predictionCard: { select: { judgment: true } } } } },
  });
  if (!purchase || purchase.escrowStatus !== 'DISPUTED') {
    throw new PurchaseVoidError('NOT_VOIDABLE', '분쟁 중인 구매가 아닙니다.');
  }

  const judged = !!purchase.report.predictionCard?.judgment;
  await prisma.purchase.update({
    where: { id: purchase.id },
    data: { escrowStatus: input.resolution === 'WON' ? 'HELD' : 'CANCELLED' },
  });
  await prisma.notification.create({
    data: {
      userId: purchase.buyerId,
      type: 'OPS_ALERT',
      title: input.resolution === 'WON' ? '결제 분쟁 종료' : '결제 분쟁 종료 — 구매 취소',
      body:
        input.resolution === 'WON'
          ? '제기하신 결제 분쟁이 종료되어 구매가 유지됩니다.'
          : '결제 분쟁에 따라 구매가 취소되었습니다. 해당 리포트는 더 이상 열람할 수 없습니다.',
      createdAt: now,
    },
  });

  // 판정이 이미 났는데 이겼다면 그 구매의 정산이 비어 있다 — 배치는 다시 안 돈다
  return { settlementNeeded: input.resolution === 'WON' && judged };
}
