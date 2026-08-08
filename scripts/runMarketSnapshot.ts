import { PrismaClient } from '@prisma/client';
import { takeMarketSnapshot } from '../src/server/marketStats';

// 마켓 규모 스냅샷 — 매시간 실행한다 (npm run batch:snapshot).
//
// 띠지의 증감(+3)은 "지금 값 − 과거 값"인데, 과거 값은 지금 조회로 알 수 없다.
// 누적 판정처럼 시점이 남는 값은 재구성이라도 되지만, 검증 중 카드 수는 시한이
// 지나면 사라져 복원 자체가 불가능하다. 그래서 그때그때 찍어 둔다.
//
// 멱등하지 않다 — 부를 때마다 한 줄이 쌓인다. 시간당 한 번이라는 전제가 곧 해상도다.
// 두 번 돌아도 값이 틀어지지는 않는다(비교는 "창 이전 가장 최근" 한 줄만 쓴다).

const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  const numbers = await takeMarketSnapshot(prisma, now);
  console.log(
    JSON.stringify({ takenAt: now.toISOString(), ...numbers }, null, 2),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
