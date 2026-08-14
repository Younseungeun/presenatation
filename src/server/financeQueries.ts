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
  /**
   * 결제 분쟁으로 **지급이 보류된** 금액 (차지백 접수, escrowStatus=DISPUTED).
   *
   * "정산 대기"에 섞으면 안 된다 — 리서처는 언젠가 받을 돈으로 읽는데 실제로는
   * 우리도 못 받은 돈이고, 분쟁에서 지면 영영 안 나간다. 그렇다고 조용히 빼면
   * **정산액이 이유 없이 줄어든 것처럼 보여** "플랫폼이 떼어먹었다"가 된다.
   * 따로 세어 이름을 붙이는 것이 유일하게 정직한 처리다
   */
  disputedKrw: number;
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
    // **무효화된 구매는 판매가 아니다.** CS 환불은 거래 자체를 없던 것으로 되돌리는
    // 일이라 판매 건수에도 금액에도 들어가면 안 된다 (판정 실패 환불과 다른 점)
    where: { report: { researcherId }, escrowStatus: { not: 'CANCELLED' } },
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
      disputedKrw: 0,
    };
    row.salesCount++;
    if (p.settlement) {
      row.payoutKrw += p.settlement.researcherPayoutKrw;
      row.refundedKrw += p.settlement.buyerRefundKrw;
    } else if (p.escrowStatus === 'DISPUTED') {
      row.disputedKrw += p.amountKrw;
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
      disputedKrw: acc.disputedKrw + r.disputedKrw,
    }),
    { salesCount: 0, heldKrw: 0, payoutKrw: 0, refundedKrw: 0, disputedKrw: 0 },
  );

  return { totals, byReport };
}
