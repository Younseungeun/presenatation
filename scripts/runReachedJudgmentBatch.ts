import { PrismaClient } from '@prisma/client';
import { runReachedJudgmentBatch } from '../src/server/reachedJudgmentBatch';
import { createDefaultRegistry } from '../src/infra/marketData/registry';

// 도달 판정 배치 — npm run batch:reached
// 일봉 종가가 목표에 닿은 카드를 그 자리에서 판정·정산한다.
// "조기"가 아니다 — 예측("기한 안에 닿는다")이 이뤄진 날 판정하는 것이다.

async function main() {
  const prisma = new PrismaClient();
  try {
    const s = await runReachedJudgmentBatch(prisma, createDefaultRegistry(), new Date());
    console.log(
      `도달 판정: 대상 ${s.checked} / 판정 ${s.judged} / 아직 ${s.notYet} / 이월 ${s.deferred} / 실패 ${s.failed}`,
    );
    if (s.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
main();
