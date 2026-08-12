import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { syncKrCardInstrumentRisk } from '../src/server/krRiskSync';

// 국내 종목 경보 갱신 CLI — npm run risk:sync
// 규칙·근거는 server/krRiskSync.ts에 있다 (스케줄러도 같은 함수를 부른다).

const prisma = new PrismaClient();

async function main() {
  const s = await syncKrCardInstrumentRisk(prisma, createDefaultRegistry());
  console.log(
    `대상 ${s.checked}종목 — 등급 상향 ${s.raised} / 수동값 유지 ${s.keptManual} / 실패 ${s.failed}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
