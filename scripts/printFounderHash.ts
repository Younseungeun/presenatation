import { PrismaClient } from '@prisma/client';

// 관리자 신원 고정용 해시 출력:
//   npm run op:hash -- <email 또는 필명>
//
// 출력된 값을 서버 환경 변수 `FOUNDER_CI_HASH`에 넣으면, 그 신원(CI)의 본인 인증이
// 곧 관리자 승격이 된다 (server/authService.verifyAndSignIn) — 앱 재설치·DB 초기화
// 뒤에도 풀 로그인 한 번이면 관리자 화면이 돌아온다.
//
// 값은 CI의 HMAC 해시라 비밀번호 같은 자격증명이 아니다 — 다만 특정인을 가리키는
// 값이므로 코드·저장소에는 넣지 않는다(환경 변수에만).

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error('사용법: npm run op:hash -- <email 또는 필명>');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: key }, { penName: key }] },
      select: { identityHash: true, penName: true, email: true, role: true },
    });
    if (!user) {
      console.error(`계정을 찾을 수 없습니다: ${key}`);
      process.exitCode = 1;
      return;
    }
    if (!user.identityHash) {
      console.error('이 계정은 본인 인증을 거치지 않아 신원 해시가 없습니다.');
      process.exitCode = 1;
      return;
    }
    console.log(`계정: ${user.penName ?? user.email} (role=${user.role})`);
    console.log(`FOUNDER_CI_HASH=${user.identityHash}`);
    console.log('\n위 값을 서버 환경 변수에 넣으면, 이 신원의 풀 로그인마다 관리자로 승격됩니다.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
