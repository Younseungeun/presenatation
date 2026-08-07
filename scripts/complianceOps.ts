import { runComplianceOps } from '../src/server/complianceOpsService';
import { prisma } from '../src/server/db';

// 보류 큐 운영 배치: npm run batch:compliance
//
// 하루 한 번 이상 돌린다. 이 배치가 없으면 보류 큐는 운영자가 열어볼 때까지
// 아무 일도 일어나지 않는 블랙홀이 된다.

async function main() {
  const summary = await runComplianceOps(prisma);

  if (summary.expired.length > 0) {
    console.log(`시한 경과로 초안 복귀 ${summary.expired.length}건:`);
    for (const r of summary.expired) console.log(`  · ${r.title} (${r.reportId})`);
  } else {
    console.log('시한 경과 보류 건 없음');
  }

  console.log(
    summary.escalated > 0
      ? `지연 재알림 ${summary.escalated}건 → 운영자 ${summary.notifiedOperators}명`
      : '지연 재알림 대상 없음',
  );

  if (summary.vectorsBackfilled !== null) {
    console.log(`의미 인덱스 벡터 계산 ${summary.vectorsBackfilled}건`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
