import { PrismaClient } from '@prisma/client';
import {
  grantOperatorRole,
  OperatorGrantError,
  revokeOperatorRole,
} from '../src/server/operatorGrantService';

// 운영자 권한 부여/회수:
//   npm run op:grant -- <email>            진짜 운영자 부여
//   npm run op:grant -- <email> --cold     콜드 계정 부여 (1인 운영 교착 해소용 금고 계정)
//   npm run op:grant -- <email> --revoke   회수
//
// **콜드 계정 회수는 이 스크립트가 아니라 코드가 한다** — 두 번째 진짜 운영자를
// 부여하는 순간, 같은 트랜잭션이 콜드를 강등하고 세션을 끊는다. 남겨 두면 한 사람이
// 콜드를 쥐고 다시 단독 승인 능력을 갖기 때문이다 (server/operatorGrantService.ts).

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    console.error('사용법: npm run op:grant -- <email> [--cold | --revoke]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    if (flag === '--revoke') {
      await revokeOperatorRole(prisma, { email, actor: `cli:${email}` });
      console.log(`${email} → role=USER (세션도 함께 끊었습니다)`);
      return;
    }
    const r = await grantOperatorRole(prisma, {
      email,
      cold: flag === '--cold',
      actor: `cli:${email}`,
    });
    console.log(`${email} → role=${r.role}${flag === '--cold' ? ' (콜드)' : ''}`);
    if (r.demotedColdAccounts.length > 0) {
      console.log(
        `진짜 운영자 2명 확보 — 콜드 계정을 강등하고 세션을 끊었습니다: ${r.demotedColdAccounts.join(', ')}`,
      );
      console.log('(남겨 두면 한 사람이 콜드를 쥐고 다시 단독 승인 능력을 갖습니다)');
    }
  } catch (e) {
    if (e instanceof OperatorGrantError) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
