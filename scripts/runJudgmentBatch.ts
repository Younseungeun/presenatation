// 판정 배치 CLI 진입점 — 크론 스케줄 (docs/market-data.md §4):
//   KR_EQUITY 매 영업일 13:30 KST / US_EQUITY 매일 09:00 KST / CRYPTO 매일 00:30 KST
// 실행: npm run batch:judge
import { PrismaClient } from '@prisma/client';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { BatchLockBusy, withBatchLock } from '../src/server/batchLock';
import { judgeAndSettleDueCards } from '../src/server/judgmentBatch';

const prisma = new PrismaClient();

async function main() {
  // **손으로 돌리는 이 경로가 동시 실행의 진짜 통로다** — 스케줄러 중복은 심박이
  // 경고하지만 수동 실행은 아무 데도 안 걸렸다. 둘이 겹치면 KIS 토큰(분당 1회)에서
  // 서로를 죽이고, 같은 카드를 집은 쪽은 unique 제약 오류를 "우리 버그"로 보고한다
  const summary = await withBatchLock(prisma, 'judge', () =>
    judgeAndSettleDueCards(prisma, createDefaultRegistry()),
  );
  console.log(
    `판정 완료 ${summary.judged}건 / 이월 ${summary.deferred}건 / 실패 ${summary.failed}건`,
  );
  if (summary.staleDeferred.length > 0) {
    console.warn('⚠️ 7일 이상 이월 — 수동 확인 필요 (보류 큐):');
    for (const line of summary.staleDeferred) console.warn(`  - ${line}`);
  }
  if (summary.failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    if (e instanceof BatchLockBusy) {
      // 기다리지 않는다 — 다음 주기가 어차피 돈다. 다만 **조용히 넘어가지도 않는다**
      console.warn(`⚠ ${e.message}\n  이번 실행은 건너뜁니다.`);
      process.exitCode = 0;
      return;
    }
    throw e;
  })
  .finally(() => prisma.$disconnect());
