import type { PrismaClient } from '@prisma/client';
import { isSalesWindowOpen } from '@/domain/salesWindow';
import { cardProfitabilityLevel, type ProfitabilityLevel } from '@/domain/profitability';
import { cardStabilityLevel, type StabilityLevel } from '@/domain/stability';
import { isFreeReport } from './freeReportService';
import { researcherSignals } from './marketQueries';
import {
  assertPurchasableNow,
  purchaseWriteOps,
  type CheckedPurchase,
  type PaymentInput,
} from './purchaseService';

// 장바구니 — 여러 리포트를 담아 한 번에 결제한다.
//
// 담기와 결제의 검증을 나눈 이유: 담아둔 사이에 상태가 바뀔 수 있다(시한 경과, 판매 종료,
// 다른 경로로 먼저 구매). 그래서 담을 때 한 번 거르고, 결제 시점에 purchaseReport가
// 최종 검증을 다시 한다. 결제 결과는 건별로 성공/실패를 돌려주고, 실패 건은 장바구니에
// 남긴다 — 한 건 때문에 전체가 막히면 사용자가 원인을 알 수 없다.

export type CartItemIssue =
  | 'DEADLINE_PASSED'
  | 'NOT_PUBLISHED'
  | 'ALREADY_PURCHASED'
  | 'OWN_REPORT'
  | 'SALES_CLOSED';

/**
 * 담긴 리포트 1건 + 지금 결제 가능한지.
 * 장바구니는 구매 전이라 제목·요약·종목을 싣지 않는다 (구매 전 마스킹 규칙 §2.1) —
 * 무엇을 담았는지는 리서처와 예측의 모양(자산군·방향·수익성)으로 식별한다.
 */
export interface CartEntry {
  reportId: string;
  priceKrw: number;
  prepaymentRatio: number;
  researcherName: string;
  researcherId: string;
  tier: string;
  careerBadge: string | null;
  hitRate: number | null;
  judgedCount: number;
  repurchaseRate: number | null;
  assetClass: string | null;
  direction: string | null;
  profitability: ProfitabilityLevel | null;
  stability: StabilityLevel | null;
  confidence: number | null;
  deadline: Date | null;
  publishedAt: Date | null;
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

/**
 * 담을 수 있는 최대 개수.
 *
 * 일괄 결제가 **전부 아니면 아무것도**로 바뀌면서 생긴 제약이다. 결제 한 번에 담긴 것
 * 전부의 실시간 시세를 조회하고(네트워크) 그만큼의 행을 한 트랜잭션에 묶으므로,
 * 개수가 늘수록 조회 시간과 잠금 구간이 같이 늘고 **하나라도 q 방어선에 걸릴 확률**도
 * 올라간다. 많이 담은 사람일수록 결제가 안 되는 역설을 여기서 끊는다.
 */
export const MAX_CART_ITEMS = 20;

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
  // 이미 담긴 것을 다시 담는 건 개수를 늘리지 않으므로 상한에 걸리지 않아야 한다
  const alreadyIn = await prisma.cartItem.findUnique({
    where: { userId_reportId: { userId, reportId } },
  });
  if (!alreadyIn && (await countCart(prisma, userId)) >= MAX_CART_ITEMS) {
    throw new Error(
      `카드지갑에는 최대 ${MAX_CART_ITEMS}건까지 담을 수 있습니다. 일괄 결제는 담긴 것을 한 번에 처리하므로, 먼저 결제하거나 몇 건을 빼주세요.`,
    );
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
  // 카드에 함께 나가는 리서처 신뢰 지표 (적중률·재구매율)
  const signals = await researcherSignals(
    prisma,
    [...new Set(items.map((i) => i.report.researcherId))],
  );
  const purchasedIds = new Set(purchases.map((p) => p.reportId));

  const entries: CartEntry[] = items.map((i) => {
    const r = i.report;
    let issue: CartItemIssue | null = null;
    if (purchasedIds.has(r.id)) issue = 'ALREADY_PURCHASED';
    else if (r.researcher.userId === userId) issue = 'OWN_REPORT';
    else if (r.status !== 'PUBLISHED') issue = 'NOT_PUBLISHED';
    // 담아둔 사이에 판매가 마감될 수 있다 — 시한과 같은 "상태 변화" 계열
    else if (r.salesClosedAt) issue = 'SALES_CLOSED';
    // **시한 경과를 판매 기간보다 먼저 본다.** 판매 기간은 시한보다 항상 먼저 끝나므로
    // 시한이 지난 카드는 판매 기간도 지나 있다. 그때 "판매 기간이 끝났다"고 말하면
    // 틀린 말은 아니어도 덜 말한 것이다 — 그 카드는 이미 판정을 기다리는 중이다
    else if (r.predictionCard && r.predictionCard.deadline <= now) issue = 'DEADLINE_PASSED';
    // 시간 규칙은 배치가 salesClosedAt을 채우기 전에도 이미 참이므로 여기서 계산한다 —
    // 카드지갑이 "구매 가능"이라 말한 뒤 결제에서 거부되면 그게 더 나쁜 경험이다
    else if (!isSalesWindowOpen(r.publishedAt, r.predictionCard?.deadline, now))
      issue = 'SALES_CLOSED';

    const card = r.predictionCard;
    return {
      reportId: r.id,
      priceKrw: r.priceKrw,
      prepaymentRatio: r.prepaymentRatio,
      researcherName: r.researcher.user.penName ?? r.researcher.user.email,
      researcherId: r.researcherId,
      tier: r.researcher.tier,
      careerBadge: r.researcher.careerBadge,
      hitRate: signals.get(r.researcherId)?.hitRate ?? null,
      judgedCount: signals.get(r.researcherId)?.judgedCount ?? 0,
      repurchaseRate: signals.get(r.researcherId)?.repurchaseRate ?? null,
      assetClass: card?.assetClass ?? null,
      direction: card?.direction ?? null,
      profitability: card ? cardProfitabilityLevel(card) : null,
      stability: cardStabilityLevel(card?.sigmaDaily),
      confidence: card?.confidence ?? null,
      deadline: card?.deadline ?? null,
      publishedAt: r.publishedAt,
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

export interface CheckoutFailure {
  reportId: string;
  reason: string;
  /**
   * 이 건이 **막은 쪽**인가. false면 남의 사정으로 함께 접힌 건이다.
   * 화면이 "막은 것만 빼고 다시 결제"를 만들려면 이 구분이 필요하다 —
   * 사유 문자열을 클라이언트에서 비교하게 두면 문구를 고칠 때마다 조용히 깨진다.
   */
  blocking: boolean;
}

export interface CheckoutResult {
  purchased: string[];
  failed: CheckoutFailure[];
}

/** 다른 건 때문에 함께 취소됐을 때의 사유 — 돈이 나가지 않았음을 분명히 말한다 */
export const BLOCKED_BY_SIBLING =
  '함께 담긴 다른 카드가 결제되지 않아 이번 결제는 진행되지 않았습니다 (결제된 금액 없음)';

/**
 * 장바구니 결제 — **전부 사거나, 아무것도 사지 않는다.**
 *
 * 예전에는 건별로 성공/실패를 돌려주고 실패 건만 장바구니에 남겼다. 그 편이 "한 건
 * 때문에 전체가 막히면 사용자가 원인을 알 수 없다"는 점에서 나아 보였는데, **실PG를
 * 붙이는 순간 성립하지 않는다.** 결제창은 담긴 것의 합산 금액을 한 번에 승인한다.
 * 3건 30,000원을 승인해 놓고 2번째에서 막히면 **돈은 다 냈는데 1건만 받는다.**
 *
 * 그래서 순서를 바꿨다:
 *   ① 결제 가능한 건 **전부**를 먼저 검증한다 (시세 조회 포함 — 네트워크라 트랜잭션 밖)
 *   ② 하나라도 막히면 **아무것도 만들지 않고** 무엇이 막았는지 돌려준다
 *   ③ 전부 통과하면 구매 생성과 장바구니 비우기를 **한 트랜잭션**으로 실행한다
 *
 * 원인을 알 수 없다는 문제는 ②가 사유를 건별로 돌려주는 것으로 갚는다 — 결제 **전에**
 * 알려주는 편이 결제 후에 부분 실패를 설명하는 것보다 낫다.
 *
 * **실PG를 붙일 때**: 승인 → 이 함수 → `purchased.length === 0`이면 승인 전체를
 * 취소해야 한다 (paymentIntentService.voidAfterCapture와 같은 보상 트랜잭션).
 */
export async function checkoutCart(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
  payment: PaymentInput = { method: 'CARD' },
): Promise<CheckoutResult> {
  const { entries } = await getCart(prisma, userId, now);
  const result: CheckoutResult = { purchased: [], failed: [] };

  // ① 전부 검증 — 쓰기는 아직 하나도 없다
  const checked: CheckedPurchase[] = [];
  for (const e of entries) {
    if (e.issue !== null) {
      result.failed.push({ reportId: e.reportId, reason: issueMessage(e.issue), blocking: true });
      continue;
    }
    try {
      checked.push(await assertPurchasableNow(prisma, e.reportId, userId, now));
    } catch (err) {
      result.failed.push({
        reportId: e.reportId,
        reason: err instanceof Error ? err.message : '구매 실패',
        blocking: true,
      });
    }
  }

  // ② 하나라도 막혔으면 전부 접는다
  if (result.failed.length > 0) {
    for (const c of checked) {
      result.failed.push({ reportId: c.reportId, reason: BLOCKED_BY_SIBLING, blocking: false });
    }
    return result;
  }
  if (checked.length === 0) return result;

  // ③ 전부 한 트랜잭션 — 하나라도 실패하면(P2025 등) 전체가 되돌아간다
  const ops = checked.map((c) => purchaseWriteOps(prisma, c, userId, payment));
  try {
    await prisma.$transaction([
      ...ops.flatMap((o) => [o.guard, o.create]),
      prisma.cartItem.deleteMany({
        where: { userId, reportId: { in: checked.map((c) => c.reportId) } },
      }),
    ]);
    result.purchased.push(...checked.map((c) => c.reportId));
  } catch (err) {
    // 어느 건이 막았는지 트랜잭션은 알려주지 않는다 — 전부 실패로 돌려주고 사유를 싣는다
    const reason = err instanceof Error ? err.message : '구매 실패';
    for (const c of checked) {
      result.failed.push({ reportId: c.reportId, reason, blocking: true });
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
    case 'SALES_CLOSED':
      return '판매가 마감된 리포트입니다 (카드는 시한에 정상 판정됩니다)';
  }
}

export function countCart(prisma: PrismaClient, userId: string): Promise<number> {
  return prisma.cartItem.count({ where: { userId } });
}
