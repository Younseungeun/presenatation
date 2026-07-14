// 시즌 재산정 배치 CLI — 분기 첫날 00:10 KST 크론 실행 (1/4/7/10월 1일)
// 실행: npm run batch:season
import { PrismaClient } from '@prisma/client';
import { recalcSeasonTiers } from '../src/server/seasonRecalcService';

const prisma = new PrismaClient();

async function main() {
  const s = await recalcSeasonTiers(prisma);
  console.log(
    `${s.season} 시즌 재산정: 평가 ${s.evaluated}명 — 승급 ${s.promoted} / 강등 ${s.demoted} / 유지 ${s.unchanged}`,
  );
}

main().finally(() => prisma.$disconnect());
