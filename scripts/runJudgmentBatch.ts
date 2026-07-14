// 판정 배치 CLI 진입점 — 크론 스케줄 (docs/market-data.md §4):
//   KR_EQUITY 매 영업일 13:30 KST / US_EQUITY 매일 09:00 KST / CRYPTO 매일 00:30 KST
// 실행: npm run batch:judge
import { PrismaClient } from '@prisma/client';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { judgeAndSettleDueCards } from '../src/server/judgmentBatch';

const prisma = new PrismaClient();

async function main() {
  const summary = await judgeAndSettleDueCards(prisma, createDefaultRegistry());
  console.log(
    `판정 완료 ${summary.judged}건 / 이월 ${summary.deferred}건 / 실패 ${summary.failed}건`,
  );
  if (summary.staleDeferred.length > 0) {
    console.warn('⚠️ 7일 이상 이월 — 수동 확인 필요 (보류 큐):');
    for (const line of summary.staleDeferred) console.warn(`  - ${line}`);
  }
  if (summary.failed > 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
