import { PrismaClient } from '@prisma/client';

// **낙관적 동시성이 Postgres에서도 정말 막는지 실측한다.**
//
// 구매·게시·판매마감이 전부 같은 패턴을 쓴다:
//
//     prisma.report.update({ where: { id, status: 'PUBLISHED', salesClosedAt: null }, data: {} })
//
// "조건에 맞을 때만 쓰고, 안 맞으면 P2025로 터진다"에 기대는 구조다. SQLite에서는
// 쓰기가 직렬화되므로 항상 맞았는데, Postgres 기본 격리 수준(Read Committed)에서도
// 같은지는 **돌려보지 않으면 알 수 없다.** 이론상으로는 두 번째 UPDATE가 첫 번째의
// 행 잠금에 걸려 대기하고, 커밋 후 조건을 다시 평가해 0행이 되는 것이 맞다
// (Postgres의 UPDATE는 잠금 해제 후 최신 행으로 조건을 재확인한다).
//
// 이 스크립트는 그 시나리오를 두 개의 동시 트랜잭션으로 그대로 재현한다.
// **정확히 하나만 성공해야 한다.**
//
// 쓰는 법 (Postgres 전환 전에 한 번):
//   DATABASE_URL="postgresql://..." npx tsx scripts/verifyRowLock.ts
//
// SQLite로 돌리면 "동시성을 시험하지 못했다"고 알리고 끝난다 — SQLite는 쓰기를
// 직렬화하므로 통과해도 Postgres의 근거가 되지 않는다. 통과를 흉내 내면 안 된다.

const URL = process.env.DATABASE_URL ?? '';
const IS_POSTGRES = URL.startsWith('postgres');

/** 두 트랜잭션이 같은 순간에 같은 행을 노리도록 맞추는 문 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

async function main() {
  if (!IS_POSTGRES) {
    console.log('DATABASE_URL이 Postgres가 아닙니다 — 이 시험은 Postgres에서만 의미가 있습니다.');
    console.log('SQLite는 쓰기를 직렬화하므로 여기서 통과해도 Read Committed의 근거가 못 됩니다.');
    console.log(`\n  DATABASE_URL="postgresql://..." npx tsx scripts/verifyRowLock.ts\n`);
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaClient();

  // 시험용 리포트 하나 — 실데이터를 건드리지 않도록 새로 만들고 끝나면 지운다
  const researcher = await prisma.researcherProfile.findFirst();
  if (!researcher) {
    throw new Error('리서처 프로필이 하나도 없습니다 — 시드를 먼저 넣어주세요');
  }
  const report = await prisma.report.create({
    data: {
      researcherId: researcher.id,
      title: '[동시성 시험] 지워도 되는 행',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      prepaymentRatio: 0,
      feeRateBp: 2000,
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
  });

  const started = gate();
  let firstHasLock = false;

  /** 구매 경로가 실제로 쓰는 것과 같은 조건부 update */
  async function contend(label: string, holdMs: number): Promise<'WON' | 'LOST' | string> {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.report.update({
          where: { id: report.id, status: 'PUBLISHED', salesClosedAt: null },
          data: { salesClosedAt: new Date() }, // 상대의 where를 깨뜨리는 쓰기
        });
        if (label === 'A') {
          firstHasLock = true;
          started.open(); // B가 이제 같은 행을 노린다
        }
        // A가 잠금을 쥔 채 머무는 동안 B가 대기 상태로 들어가야 한다
        await new Promise((r) => setTimeout(r, holdMs));
        return 'WON' as const;
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2025') return 'LOST'; // 조건 재평가에서 밀렸다 — 기대하는 결과
      return `ERROR(${code ?? (e as Error).message})`;
    }
  }

  const a = contend('A', 1_500);
  const b = (async () => {
    await started.wait;
    if (!firstHasLock) throw new Error('시험 순서가 어긋났습니다');
    return contend('B', 0);
  })();

  const [ra, rb] = await Promise.all([a, b]);
  const won = [ra, rb].filter((r) => r === 'WON').length;
  const lost = [ra, rb].filter((r) => r === 'LOST').length;

  console.log(`\nA: ${ra}\nB: ${rb}`);
  if (won === 1 && lost === 1) {
    console.log('\n✅ 정확히 하나만 성공했습니다 — Read Committed에서 조건부 update가 막아줍니다.');
  } else {
    console.log('\n❌ 기대와 다릅니다. 둘 다 성공했다면 구매가 이중으로 만들어질 수 있습니다.');
    console.log('   이 경우 $transaction의 격리 수준을 Serializable로 올리거나');
    console.log('   SELECT ... FOR UPDATE(rawQuery)로 명시적 잠금을 잡아야 합니다.');
    process.exitCode = 1;
  }

  await prisma.report.delete({ where: { id: report.id } });
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
