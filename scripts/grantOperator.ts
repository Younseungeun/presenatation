import { PrismaClient } from '@prisma/client';

// 운영자 권한 부여/회수: npm run op:grant -- <email> [--revoke]
// 운영자는 /admin/judgments 에서 판정 보류 큐를 수동 판정할 수 있다.

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    console.error('사용법: npm run op:grant -- <email> [--revoke]');
    process.exit(1);
  }
  const role = flag === '--revoke' ? 'USER' : 'OPERATOR';

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.update({ where: { email }, data: { role } });
    console.log(`${user.email} → role=${user.role}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
