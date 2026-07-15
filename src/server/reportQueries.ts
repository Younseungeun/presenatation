import type { PrismaClient } from '@prisma/client';

// 화면(서버 컴포넌트)용 읽기 전용 조회. 쓰기는 reportService/purchaseService가 담당.

/** 리서처 프로필 + 대시보드에 필요한 리포트 목록 (최신순, 예측 카드·판정 포함) */
export async function getResearcherDashboard(prisma: PrismaClient, researcherId: string) {
  return prisma.researcherProfile.findUnique({
    where: { id: researcherId },
    include: {
      user: { select: { penName: true, email: true } },
      reports: {
        orderBy: { createdAt: 'desc' },
        include: {
          predictionCard: { include: { judgment: true } },
          _count: { select: { purchases: true } },
        },
      },
    },
  });
}

export type ResearcherDashboard = NonNullable<
  Awaited<ReturnType<typeof getResearcherDashboard>>
>;
export type DashboardReport = ResearcherDashboard['reports'][number];
