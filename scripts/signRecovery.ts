import { createInterface } from 'node:readline';
import { RECOVERY_TOKEN_MAX_TTL_MS, signRecoveryToken } from '../src/server/recoveryToken';

// 금고에서 꺼낸 종이로 복구 표를 찍는다:
//   npm run recovery:sign -- <창업자 이메일>
//
// 개인키는 **인자로 받지 않는다.** 명령줄 인자는 셸 기록(.bash_history)과 프로세스
// 목록에 남는다 — 금고에서 꺼낸 값이 그 순간 디스크에 적히면 종이에 둔 의미가 없다.
// 그래서 실행 후 화면에서 물어보고, 받은 값은 메모리에만 있다가 사라진다.
//
// 이 스크립트는 **인터넷이 끊긴 노트북에서** 돌린다. 나온 표를 복구 화면(/recovery)에
// 붙여 넣으면 되고, 표의 수명은 10분이다.

const email = process.argv[2];
if (!email) {
  console.error('사용법: npm run recovery:sign -- <창업자 이메일>');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('금고 속 종이 열쇠를 입력하세요: ', (paperKey) => {
  rl.close();
  try {
    const token = signRecoveryToken(paperKey, { email });
    console.log('');
    console.log('─── 복구 표 (10분 뒤 만료, 1회용) ───────────────────────');
    console.log(token);
    console.log('');
    console.log(`※ 유효 시간 ${RECOVERY_TOKEN_MAX_TTL_MS / 60_000}분. /recovery 화면에 붙여 넣으세요.`);
    console.log('※ 종이 열쇠는 이 창을 닫은 뒤에도 금고에 그대로 둡니다 — 표만 1회용입니다.');
    console.log('');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
});
