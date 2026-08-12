// 판매 마감 배치 — npm run batch:salesclose [-- --dry]
// 하루 1회 이상. --dry는 무엇이 닫힐지 보여주기만 하고 저장하지 않는다.
// 시간 규칙(WINDOW_END)과 역방향 마감(ADVERSE_MOVE)을 기록한다 —
// 역방향은 **일봉 종가로만** 판정한다 (salesCloseService 참고).
import { PrismaClient } from '@prisma/client';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
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
    const r = await runSalesCloseBatch(fake, new Date(), createDefaultRegistry());
    console.log(`[dry] 검사 ${r.checked}건 / 닫힐 카드 ${r.closed.length}건`);
    for (const c of r.closed) console.log(`  [dry] ${c.reportId} ← ${c.reason}`);
    return;
  }
  const r = await runSalesCloseBatch(prisma, new Date(), createDefaultRegistry());
  console.log(`검사 ${r.checked}건 / 마감 ${r.closed.length}건`);
  for (const c of r.closed) console.log(`  마감 ${c.reportId} ← ${c.reason}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
