// 개발용 시드: 인증 스텁(x-researcher-id)에 쓸 리서처 1명을 만들고 ID를 출력한다.
// 실행: npm run seed:dev
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'dev@test.io' },
    update: {},
    create: {
      email: 'dev@test.io',
      penName: '개발용리서처',
      identityVerified: true,
      researcherProfile: { create: {} },
    },
    include: { researcherProfile: true },
  });
  console.log(`researcherId: ${user.researcherProfile!.id}`);
}

main().finally(() => prisma.$disconnect());
