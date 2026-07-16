import type { PrismaClient } from '@prisma/client';

// 인앱 알림 조회·읽음 처리. 생성은 판정 트랜잭션(judgmentWriter)에서 함께 일어난다.

export function getNotifications(prisma: PrismaClient, userId: string, limit = 50) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export function unreadNotificationCount(prisma: PrismaClient, userId: string) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/** 알림함 열람 시 전체 읽음 처리 */
export async function markAllNotificationsRead(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
) {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: now },
  });
  return count;
}
