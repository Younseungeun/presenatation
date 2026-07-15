import type { PrismaClient } from '@prisma/client';

// 돈의 흐름 조회 (읽기 전용): 구매자의 구매 내역, 리서처의 판매·정산 집계.

/** 구매자의 구매 내역 — 판정·정산 상태 포함, 최신순 */
export async function getBuyerPurchases(prisma: PrismaClient, buyerId: string) {
  return prisma.purchase.findMany({
    where: { buyerId },
    orderBy: { paidAt: 'desc' },
    include: {
      settlement: true,
      report: {
        include: {
          predictionCard: { include: { judgment: true } },
          researcher: { include: { user: { select: { penName: true, email: true } } } },
        },
      },
    },
  });
}

export type BuyerPurchase = Awaited<ReturnType<typeof getBuyerPurchases>>[number];

export interface ReportFinance {
  reportId: string;
  title: string;
  salesCount: number;
  /** 에스크로 보관 중 금액 (판정 전) */
  heldKrw: number;
  /** 확정 정산액 (수수료 차감 후 리서처 몫) */
  payoutKrw: number;
  /** 구매자에게 환불된 금액 */
  refundedKrw: number;
}

export interface ResearcherFinance {
  totals: Omit<ReportFinance, 'reportId' | 'title'>;
  byReport: ReportFinance[];
}

/** 리서처의 판매·정산 집계 — 대시보드 요약용 */
export async function getResearcherFinance(
  prisma: PrismaClient,
  researcherId: string,
): Promise<ResearcherFinance> {
  const purchases = await prisma.purchase.findMany({
    where: { report: { researcherId } },
    include: { settlement: true, report: { select: { id: true, title: true } } },
  });

  const byReportMap = new Map<string, ReportFinance>();
  for (const p of purchases) {
    const row = byReportMap.get(p.report.id) ?? {
      reportId: p.report.id,
      title: p.report.title,
      salesCount: 0,
      heldKrw: 0,
      payoutKrw: 0,
      refundedKrw: 0,
    };
    row.salesCount++;
    if (p.settlement) {
      row.payoutKrw += p.settlement.researcherPayoutKrw;
      row.refundedKrw += p.settlement.buyerRefundKrw;
    } else {
      row.heldKrw += p.amountKrw;
    }
    byReportMap.set(p.report.id, row);
  }

  const byReport = [...byReportMap.values()];
  const totals = byReport.reduce(
    (acc, r) => ({
      salesCount: acc.salesCount + r.salesCount,
      heldKrw: acc.heldKrw + r.heldKrw,
      payoutKrw: acc.payoutKrw + r.payoutKrw,
      refundedKrw: acc.refundedKrw + r.refundedKrw,
    }),
    { salesCount: 0, heldKrw: 0, payoutKrw: 0, refundedKrw: 0 },
  );

  return { totals, byReport };
}
