import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { refreshWatchedQuotes } from '../src/server/quoteWatchService';

// 장중 시세 갱신 — npm run batch:quotes (2분 주기 권장)
//
// **감시 대상만** 다시 부른다. 문턱에서 먼 종목은 목록에서 걸러낼 이유가 없으니
// 갱신할 이유도 없다 — 그래서 종목이 늘어도 호출이 선형으로 늘지 않는다.
// 감시 목록은 두 곳에서 채워진다: 판정·마감 배치의 일봉 종가(추가 호출 0)와
// 결제 전 실시간 호출(사려는 사람이 관측해 준다). 설계는 domain/quoteWatch.ts.

const prisma = new PrismaClient();

async function main() {
  const r = await refreshWatchedQuotes(prisma, createDefaultRegistry());
  console.log(
    `감시 ${r.watched}종목 / 갱신 ${r.refreshed} / 해제 ${r.released} / 실패 ${r.failed}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
