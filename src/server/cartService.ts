import type { PrismaClient } from '@prisma/client';
import { isFreeReport } from './freeReportService';
import { purchaseReport, type PaymentInput } from './purchaseService';

// 장바구니 — 여러 리포트를 담아 한 번에 결제한다.
//
// 담기와 결제의 검증을 나눈 이유: 담아둔 사이에 상태가 바뀔 수 있다(시한 경과, 판매 종료,
// 다른 경로로 먼저 구매). 그래서 담을 때 한 번 거르고, 결제 시점에 purchaseReport가
// 최종 검증을 다시 한다. 결제 결과는 건별로 성공/실패를 돌려주고, 실패 건은 장바구니에
// 남긴다 — 한 건 때문에 전체가 막히면 사용자가 원인을 알 수 없다.

export type CartItemIssue = 'DEADLINE_PASSED' | 'NOT_PUBLISHED' | 'ALREADY_PURCHASED' | 'OWN_REPORT';

/** 담긴 리포트 1건 + 지금 결제 가능한지 */
export interface CartEntry {
  reportId: string;
  title: string;
  summary: string;
  priceKrw: number;
  researcherName: string;
  researcherId: string;
  assetName: string | null;
  deadline: Date | null;
  addedAt: Date;
  /** null이면 결제 가능 */
  issue: CartItemIssue | null;
}

export interface CartView {
  entries: CartEntry[];
  /** 결제 가능한 건의 합계 */
  payableKrw: number;
  payableCount: number;
}

export async function addToCart(prisma: PrismaClient, userId: string, reportId: string) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { researcher: true, predictionCard: true },
  });

  if (report.status !== 'PUBLISHED') {
    throw new Error('판매 중인 리포트만 담을 수 있습니다');
  }
  if (isFreeReport(report)) {
    throw new Error('무료 리포트는 결제 없이 열람할 수 있습니다');
  }
  if (report.researcher.userId === userId) {
    throw new Error('자기 리포트는 담을 수 없습니다');
  }
  const purchased = await prisma.purchase.findUnique({
    where: { reportId_buyerId: { reportId, buyerId: userId } },
  });
  if (purchased) {
    throw new Error('이미 구매한 리포트입니다');
  }

  // 이미 담겨 있으면 그대로 둔다 (중복 담기는 오류가 아니다)
  return prisma.cartItem.upsert({
    where: { userId_reportId: { userId, reportId } },
    update: {},
    create: { userId, reportId },
  });
}

export async function removeFromCart(prisma: PrismaClient, userId: string, reportId: string) {
  await prisma.cartItem.deleteMany({ where: { userId, reportId } });
}

export async function getCart(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<CartView> {
  const items = await prisma.cartItem.findMany({
    where: { userId },
    orderBy: { addedAt: 'desc' },
    include: {
      report: {
        include: {
          predictionCard: true,
          researcher: { include: { user: { select: { penName: true, email: true } } } },
        },
      },
    },
  });
  if (items.length === 0) return { entries: [], payableKrw: 0, payableCount: 0 };

  // 담아둔 사이에 이미 구매했을 수 있다 — 한 번에 조회해 표시에 반영
  const purchases = await prisma.purchase.findMany({
    where: { buyerId: userId, reportId: { in: items.map((i) => i.reportId) } },
    select: { reportId: true },
  });
  const purchasedIds = new Set(purchases.map((p) => p.reportId));

  const entries: CartEntry[] = items.map((i) => {
    const r = i.report;
    let issue: CartItemIssue | null = null;
    if (purchasedIds.has(r.id)) issue = 'ALREADY_PURCHASED';
    else if (r.researcher.userId === userId) issue = 'OWN_REPORT';
    else if (r.status !== 'PUBLISHED') issue = 'NOT_PUBLISHED';
    else if (r.predictionCard && r.predictionCard.deadline <= now) issue = 'DEADLINE_PASSED';

    return {
      reportId: r.id,
      title: r.title,
      summary: r.summary,
      priceKrw: r.priceKrw,
      researcherName: r.researcher.user.penName ?? r.researcher.user.email,
      researcherId: r.researcherId,
      assetName: r.predictionCard?.assetName ?? null,
      deadline: r.predictionCard?.deadline ?? null,
      addedAt: i.addedAt,
      issue,
    };
  });

  const payable = entries.filter((e) => e.issue === null);
  return {
    entries,
    payableKrw: payable.reduce((a, e) => a + e.priceKrw, 0),
    payableCount: payable.length,
  };
}

export interface CheckoutResult {
  purchased: string[];
  failed: { reportId: string; reason: string }[];
}

/**
 * 장바구니 결제 — 담긴 것 중 결제 가능한 건을 순서대로 구매한다.
 * 성공한 건만 장바구니에서 빼고, 실패한 건은 사유와 함께 남긴다.
 */
export async function checkoutCart(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
  payment: PaymentInput = { method: 'CARD' },
): Promise<CheckoutResult> {
  const { entries } = await getCart(prisma, userId, now);
  const result: CheckoutResult = { purchased: [], failed: [] };

  for (const e of entries) {
    if (e.issue !== null) {
      result.failed.push({ reportId: e.reportId, reason: issueMessage(e.issue) });
      continue;
    }
    try {
      await purchaseReport(prisma, e.reportId, userId, now, payment);
      await prisma.cartItem.deleteMany({ where: { userId, reportId: e.reportId } });
      result.purchased.push(e.reportId);
    } catch (err) {
      result.failed.push({
        reportId: e.reportId,
        reason: err instanceof Error ? err.message : '구매 실패',
      });
    }
  }
  return result;
}

export function issueMessage(issue: CartItemIssue): string {
  switch (issue) {
    case 'DEADLINE_PASSED':
      return '검증 시한이 지나 구매할 수 없습니다';
    case 'NOT_PUBLISHED':
      return '판매가 종료된 리포트입니다';
    case 'ALREADY_PURCHASED':
      return '이미 구매한 리포트입니다';
    case 'OWN_REPORT':
      return '자기 리포트는 구매할 수 없습니다';
  }
}

export function countCart(prisma: PrismaClient, userId: string): Promise<number> {
  return prisma.cartItem.count({ where: { userId } });
}
