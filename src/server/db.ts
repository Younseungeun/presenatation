import { PrismaClient } from '@prisma/client';

// Next.js 개발 모드 핫리로드에서 커넥션이 불어나지 않도록 전역 싱글턴 유지
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
