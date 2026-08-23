/**
 * 필명 없는 옛 계정에 이름을 채운다 — **필수로 바꾸기 전에 만들어진 계정용 1회성 도구.**
 *
 * 2026-08-20에 필명이 가입 필수가 됐다(domain/penName.ts). 그 전에 만들어진 계정은
 * 이름이 없어서 화면마다 부를 말이 없다. 정상 경로는 **그 사람이 다음 풀 로그인 때
 * 직접 정하는 것**이고(authService가 그때 채운다), 이 스크립트는 그 경로를 탈 수 없는
 * 시험 계정을 위한 것이다.
 *
 *   npm run backfill:pennames            무엇을 바꿀지 보여주기만 한다 (기본)
 *   npm run backfill:pennames -- --apply 실제로 채운다
 *
 * ⚠ **실명을 옮겨 적지 않는다.** 실명(User.realNameEnc)은 계좌 예금주 대조용으로만
 * 받은 값이라, 그걸 공개 표시명으로 옮기면 이용자는 자기가 알려준 적 없는 이름으로
 * 앱에 나타나게 된다. 그래서 여기서 넣는 이름은 **그 계정이 한 일**에서 나온다 —
 * 시험 데이터라는 사실이 이름에 그대로 드러나는 편이 낫다.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');

  const rows = await prisma.user.findMany({
    where: { penName: null },
    select: { id: true, email: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (rows.length === 0) {
    console.log('필명 없는 계정이 없습니다.');
    return;
  }

  console.log(`필명 없는 계정 ${rows.length}개\n`);
  let n = 0;
  const plan: { id: string; email: string; penName: string }[] = [];

  for (const r of rows) {
    const reports = await prisma.abuseReport.count({ where: { reporterId: r.id } });
    const buys = await prisma.purchase.count({ where: { buyerId: r.id } });
    const tickets = await prisma.supportTicket.count({ where: { userId: r.id } });
    n += 1;
    // 한 일이 이름이 된다 — 나중에 이 계정이 왜 있는지 보는 사람에게 그것이 가장 쓸모 있다
    const kind =
      reports > 0 ? '신고테스트' : buys > 0 ? '구매테스트' : tickets > 0 ? '문의테스트' : '테스트계정';
    plan.push({ id: r.id, email: r.email, penName: `${kind}${n}` });
  }

  for (const p of plan) {
    console.log(`  ${p.email.padEnd(42)} → ${p.penName}`);
  }

  if (!apply) {
    console.log('\n미리보기입니다. 실제로 채우려면 `-- --apply`를 붙여 다시 실행하세요.');
    return;
  }

  for (const p of plan) {
    await prisma.user.update({ where: { id: p.id }, data: { penName: p.penName } });
  }
  console.log(`\n${plan.length}개 계정에 필명을 채웠습니다.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
