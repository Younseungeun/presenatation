import { PrismaClient } from '@prisma/client';
import { confirmDelayedBaseBatch } from '../src/server/delayedBaseService';
import { createDefaultRegistry } from '../src/infra/marketData/registry';

// 기준가 확정 배치 — npm run batch:confirmbase
// 장중·장후 게시 <14일 주식(DAY_CLOSE_AT_CLOSE)을 게시일 마감 종가로 확정하고 판매를 연다.
// 스케줄러가 마감+5분에 자동으로 돌린다(judgeMarketLocked) — 이건 수동/점검용.

async function main() {
  const prisma = new PrismaClient();
  try {
    const s = await confirmDelayedBaseBatch(prisma, createDefaultRegistry(), new Date());
    console.log(
      `기준가 확정: 대상 ${s.checked} / 확정 ${s.confirmed} / 무효 ${s.invalidated} / 대기 ${s.notYet} / 실패 ${s.failed}`,
    );
    if (s.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
main();
