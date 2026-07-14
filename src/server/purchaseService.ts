import type { PrismaClient } from '@prisma/client';

// 구매 → 에스크로 보관. PG(웹 결제) 연동 전까지는 결제 성공을 가정하는 스텁 —
// 실제 연동 시 PG 승인 후 이 함수를 호출하는 구조가 된다 (금액·상태 기록은 동일).

export async function purchaseReport(
  prisma: PrismaClient,
  reportId: string,
  buyerId: string,
  now = new Date(),
) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { researcher: true, predictionCard: true },
  });

  if (report.status !== 'PUBLISHED') {
    throw new Error(`판매 중인 리포트가 아닙니다 (현재: ${report.status})`);
  }
  if (report.researcher.userId === buyerId) {
    throw new Error('자기 리포트는 구매할 수 없습니다 (자기 구매 조작 방지)');
  }
  // 시한이 지난 카드는 곧 판정되므로 신규 구매 차단 (결과를 보고 사는 것 방지)
  if (report.predictionCard && report.predictionCard.deadline <= now) {
    throw new Error('검증 시한이 지난 리포트는 구매할 수 없습니다');
  }

  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: buyerId } });
  if (!buyer.identityVerified) {
    throw new Error('본인 인증 후 구매할 수 있습니다');
  }

  // @@unique([reportId, buyerId])가 중복 구매를 차단한다
  return prisma.purchase.create({
    data: {
      reportId,
      buyerId,
      amountKrw: report.priceKrw,
      escrowStatus: 'HELD',
    },
  });
}
