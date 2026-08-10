import { PrismaClient } from '@prisma/client';
import { runEarlyJudgmentBatch } from '../src/server/earlyJudgmentBatch';
import { createDefaultRegistry } from '../src/infra/marketData/registry';

// 조기 판정 배치 — npm run batch:earlyjudge
// 판정 배치와 같은 주기로 돌린다. 목표에 닿아 결과가 이미 확정된 카드를 그 자리에서
// 판정·정산한다 (결과는 바뀌지 않고 시점만 앞당겨진다 — earlyJudgmentBatch.ts 참고).

async function main() {
  const prisma = new PrismaClient();
  try {
    const s = await runEarlyJudgmentBatch(prisma, createDefaultRegistry(), new Date());
    console.log(
      `조기 판정: 대상 ${s.checked} / 판정 ${s.judged} / 아직 ${s.notYet} / 이월 ${s.deferred} / 실패 ${s.failed}`,
    );
    if (s.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
main();
