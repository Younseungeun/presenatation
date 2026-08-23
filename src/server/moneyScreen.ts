import type { PrismaClient } from '@prisma/client';
import { MONTHLY_COMPENSATION_BUDGET_KRW, monthCompensatedKrw } from '@/server/compensationBudget';
import { DAILY_OUTFLOW_LIMIT_KRW, todayOutflowKrw } from '@/server/payoutVelocity';
import { getCooldownHold } from '@/server/settlementCooldown';
import { getPendingPayouts, getPendingRefunds } from '@/server/settlementOpsService';
import {
  getApprovedCompensations,
  getPendingCompensationReviews,
} from '@/server/compensationService';
import { listFrozenAccounts } from '@/server/payoutAccountService';

// 돈 화면이 한 번에 읽는 것 (시안 v3 scr-money).
//
// **탭 다섯은 돈이 움직이는 방향으로 갈린다** — 금액대나 상태가 아니다:
//   환불   구매자에게 돌려주는 돈 (판단 끝, 실행만 남음)
//   지급   리서처에게 나가는 돈 (한도·쿨다운이 붙는 유일한 갈래)
//   보상   **우리 자본**이 나가는 유일한 갈래 (나머지 셋은 남의 돈을 옮긴다)
//   되돌리기  돈을 옮기는 게 아니라 **판매를 없던 일로** 만든다
//   문의   "안 들어왔다"는 사람들 — 실행 큐와 시계가 다르게 간다
//
// 한 곳에서 세는 이유: 탭 라벨의 숫자와 각 탭 안의 목록이 갈라지면 탭이 거짓말을 한다.

export const MONEY_TABS = ['refund', 'payout', 'comp', 'undo', 'ask'] as const;
export type MoneyTab = (typeof MONEY_TABS)[number];

export function isMoneyTab(v: string | undefined): v is MoneyTab {
  return (MONEY_TABS as readonly string[]).includes(v ?? '');
}

export const MONEY_TAB_LABEL: Record<MoneyTab, string> = {
  refund: '환불',
  payout: '지급',
  comp: '보상',
  undo: '되돌리기',
  ask: '문의',
};

type PendingRefund = Awaited<ReturnType<typeof getPendingRefunds>>[number];

export type RefundGroup = {
  /** 묶음의 열쇠 — 한 리포트가 실패로 끝나면 그 구매자 전원이 같은 이유로 돌려받는다 */
  reportId: string;
  reportTitle: string;
  outcome: string;
  totalKrw: number;
  /** 전원이 같은 금액인가 — 다르면 "각 12,900원"이라고 말할 수 없다 */
  sameAmount: boolean;
  items: PendingRefund[];
};

/**
 * **같은 리포트의 환불은 한 덩어리다** (시안 scr-money).
 *
 * 한 카드가 실패로 판정되면 그 리포트를 산 사람 전원의 환불 지시서가 **같은 순간에**
 * 태어난다. 판단은 이미 끝났고 남은 것은 실행뿐인데, 이걸 구매자마다 따로 늘어놓으면
 * 셋 중 둘만 누르고 화면을 뜨는 일이 생긴다 — 그리고 남은 하나는 "왜 이 사람만 아직
 * 못 받았나"가 되어 문의로 돌아온다. 클릭 수를 줄이는 것이 목적이 아니라 **반쯤 하다
 * 마는 상태를 만들지 않는 것**이 목적이다.
 *
 * 묶어도 실행은 건별로 남는다 — 지시서·감사·PG 호출은 구매 단위이고, 한도에 걸리거나
 * 이의가 붙은 건은 그 건만 멈춘다. 묶음은 **손이 움직이는 단위**이지 돈의 단위가 아니다.
 *
 * 끝나지 않은 시도가 있는 건은 묶지 않는다 — 그쪽은 "새로 실행"이 아니라 재시도·상태
 * 확정이라 물어볼 것이 다르다.
 */
export function groupRefundsByReport(refunds: PendingRefund[]): RefundGroup[] {
  const byReport = new Map<string, PendingRefund[]>();
  for (const r of refunds) {
    if (r.refundAttempts.length > 0) continue;
    const key = r.purchase.report.id;
    const list = byReport.get(key);
    if (list) list.push(r);
    else byReport.set(key, [r]);
  }
  return [...byReport.values()]
    .filter((items) => items.length > 1)
    .map((items) => ({
      reportId: items[0].purchase.report.id,
      reportTitle: items[0].purchase.report.title,
      outcome: items[0].outcome,
      totalKrw: items.reduce((s, r) => s + r.buyerRefundKrw, 0),
      sameAmount: items.every((r) => r.buyerRefundKrw === items[0].buyerRefundKrw),
      items,
    }));
}

export async function getMoneyScreen(prisma: PrismaClient, now = new Date()) {
  const [
    refunds,
    payouts,
    hold,
    compReviews,
    compExecutable,
    frozen,
    manualVoids,
    asks,
    spentToday,
    spentThisMonth,
  ] = await Promise.all([
    getPendingRefunds(prisma, now),
    getPendingPayouts(prisma, now),
    getCooldownHold(prisma, now),
    getPendingCompensationReviews(prisma),
    getApprovedCompensations(prisma),
    listFrozenAccounts(prisma),
    // **돈은 빠졌는데 상품이 없는 상태.** 앱 밖(토스 콘솔)에서 끝내고 여기엔 기록만 남긴다 —
    // 이 목록이 없으면 발견 경로가 알림 하나뿐이고, 알림은 지나가면 끝이다
    prisma.paymentIntent.findMany({
      where: { status: 'REQUIRES_MANUAL_VOID' },
      orderBy: { createdAt: 'asc' },
      include: { buyer: { select: { penName: true, email: true } } },
    }),
    prisma.supportTicket.findMany({
      where: { desk: 'money', status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { penName: true, email: true } } },
    }),
    todayOutflowKrw(prisma, now),
    monthCompensatedKrw(prisma, now),
  ]);

  const refundTotal = refunds.reduce((s, r) => s + r.buyerRefundKrw, 0);
  const refundGroups = groupRefundsByReport(refunds);
  const payoutTotal = payouts.reduce((s, p) => s + p.researcherPayoutKrw, 0);
  const compTotal =
    compReviews.reduce((s, g) => s + g.totalKrw, 0) +
    compExecutable.reduce((s, c) => s + c.amountKrw, 0);

  const remaining = Math.max(0, DAILY_OUTFLOW_LIMIT_KRW - spentToday);
  // 한도에 막혀 오늘 실행되지 않는 건 — 카드가 자기 자리에서 이 사실을 말해야 한다
  const blockedByLimit = payouts.filter((p) => p.researcherPayoutKrw > remaining);

  return {
    refunds,
    refundGroups,
    payouts,
    hold,
    compReviews,
    compExecutable,
    frozen,
    manualVoids,
    asks,
    counts: {
      refund: refunds.length,
      payout: payouts.length,
      comp: compReviews.length + compExecutable.length,
      undo: manualVoids.length,
      ask: asks.length,
    } satisfies Record<MoneyTab, number>,
    // 탭에 찍는 점 — 건수는 "얼마나 있나", 점은 "오늘 안 끝나는 게 있나"를 답한다
    stalled: {
      refund: false,
      payout: blockedByLimit.length > 0,
      comp: false,
      undo: manualVoids.length > 0,
      ask: asks.some((t) => now.getTime() - t.createdAt.getTime() > 12 * 3_600_000),
    } satisfies Record<MoneyTab, boolean>,
    limit: {
      spent: spentToday,
      cap: DAILY_OUTFLOW_LIMIT_KRW,
      remaining,
      ratio: Math.min(1, spentToday / DAILY_OUTFLOW_LIMIT_KRW),
      waiting: refunds.length + payouts.length + compExecutable.length,
      waitingKrw: refundTotal + payoutTotal + compExecutable.reduce((s, c) => s + c.amountKrw, 0),
      blocked: blockedByLimit.map((p) => p.researcherPayoutKrw),
    },
    budget: {
      spent: spentThisMonth,
      cap: MONTHLY_COMPENSATION_BUDGET_KRW,
      ratio: Math.min(1, spentThisMonth / MONTHLY_COMPENSATION_BUDGET_KRW),
    },
    totals: { refundTotal, payoutTotal, compTotal },
  };
}
