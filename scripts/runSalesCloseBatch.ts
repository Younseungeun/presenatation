// 판매 마감 배치 — npm run batch:salesclose [-- --dry]
// 하루 1회 이상. --dry는 무엇이 닫힐지 보여주기만 하고 저장하지 않는다.
import { PrismaClient } from '@prisma/client';
import { runSalesCloseBatch } from '../src/server/salesCloseService';

const dry = process.argv.includes('--dry');
const prisma = new PrismaClient();

async function main() {
  if (dry) {
    // 드라이런: 트랜잭션 밖에서 같은 판정만 돌리기 위해 서비스가 저장에 쓰는
    // 메서드를 가로챈다 (판정 로직은 실제와 바이트 단위로 동일해야 한다)
    const fake = new Proxy(prisma, {
      get(target, prop) {
        if (prop === '$transaction') return async () => [];
        return Reflect.get(target, prop);
      },
    }) as PrismaClient;
    const r = await runSalesCloseBatch(fake);
    console.log(`[dry] 검사 ${r.checked}건 / 닫힐 카드 ${r.closed.length}건 / 보류 ${r.skipped.length}건`);
    for (const c of r.closed) console.log(`  [dry] ${c.reportId} ← ${c.reason}`);
    for (const s of r.skipped) console.log(`  [보류] ${s.reportId} ← ${s.cause}`);
    return;
  }
  const r = await runSalesCloseBatch(prisma);
  console.log(`검사 ${r.checked}건 / 마감 ${r.closed.length}건 / 보류 ${r.skipped.length}건`);
  for (const c of r.closed) console.log(`  마감 ${c.reportId} ← ${c.reason}`);
  for (const s of r.skipped) console.log(`  보류 ${s.reportId} ← ${s.cause}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
