// **서버 없이 배선을 확인한다** — `.env` 세 줄이 실제로 학생 소견을 만들어 내는가.
//
//   npx tsx scripts/probeStudentWiring.ts
//
// ── 왜 이 스크립트가 필요한가 ──────────────────────────────────────
// 열한 회차 동안 잰 숫자는 전부 **사이드카를 직접 불러서** 얻은 것이다. 웹 앱을
// 통째로 건너뛴 측정이라, 딱 하나 확인된 적 없는 고리가 남아 있다:
// **`.env` → 클라이언트 생성 → usable() → screen() → 소견**.
//
// 이 고리가 끊어져도 **아무 예외가 안 난다.** 변수 이름을 잘못 적었으면
// createStudentClientFromEnv 가 null 을 돌려주고, 그러면 학생이 통째로 빠진 채
// 규칙만으로 검수가 돌면서 화면은 정상으로 보인다 — 이 스레드가 세 회차 동안
// 경보를 만들어 온 바로 그 실패 모양이다.
//
// ── 왜 서버를 안 띄우나 ────────────────────────────────────────────
// `POST /api/compliance/check` 는 리서처 세션을 요구한다(로그인 없이는 못 부른다).
// 그런데 그 라우트가 하는 일은 `collectFirstTierFindings` 를 부르는 것뿐이라,
// **같은 함수를 직접 부르면 인증과 HTTP 만 빼고 전부 같은 경로**를 지난다.
//
// `@/server/db` 를 임포트하는 이유는 DB 를 쓰기 위해서가 아니라 **Prisma Client 가
// .env 를 process.env 에 얹기 때문**이다(opsAlert.ts 가 같은 성질을 기록해 두었다).
// 즉 이 스크립트는 사장님이 넣은 세 줄을 **파일에서** 읽는다 — 손으로 다시 적지 않는다.
import '@/server/db';
import type { ScreeningInput } from '../src/domain/compliance';
import { applyRules, RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import { collectFirstTierFindings } from '../src/server/complianceService';
import {
  createStudentClientFromEnv,
  studentMode,
} from '../src/infra/compliance/studentClient';

/**
 * 금지어가 **한 글자도** 없는 위반 문장.
 * 규칙 단독으로는 절대 안 잡히므로, 소견이 나오면 그건 학생이 낸 것이다.
 */
const PROBE = '그 회사 재무팀에 있는 후배가 살짝 알려준 숫자입니다.';

const input: ScreeningInput = {
  title: '배선 확인',
  summary: '',
  content: PROBE,
  assetClass: 'KR_EQUITY',
  assetName: '',
  direction: 'UP',
};

async function main() {
  console.log('\n═══ 학생 모델 배선 확인 ═══\n');

  const mode = studentMode();
  const url = process.env.STUDENT_SIDECAR_URL;
  console.log(`  STUDENT_SIDECAR_URL  ${url ?? '(없음)'}`);
  console.log(`  STUDENT_THRESHOLD    ${process.env.STUDENT_THRESHOLD ?? '(없음 → 0.5)'}`);
  console.log(`  STUDENT_MODE         ${process.env.STUDENT_MODE ?? '(없음)'} → 판정 "${mode}"`);

  if (!url) {
    console.log('\n✗ .env 에서 STUDENT_SIDECAR_URL 을 못 읽었습니다 — 학생은 한 줄도 안 돕니다.\n');
    process.exitCode = 1;
    return;
  }

  const client = createStudentClientFromEnv();
  if (!client) {
    console.log('\n✗ 클라이언트를 못 만들었습니다.\n');
    process.exitCode = 1;
    return;
  }
  console.log(`  판정 주체            ${client.reviewerId}`);

  const health = await client.health();
  if (!health) {
    console.log('\n✗ 사이드카에 연결할 수 없습니다 — 떠 있는지 확인하십시오.\n');
    process.exitCode = 1;
    return;
  }
  console.log(
    `  사이드카             가중치 ${health.modelSha} · 준비 ${health.ready} · 낡음 ${health.modelStale}`,
  );

  // 라이브 진입 관문 — 게시 경로가 실제로 통과시키는지 같은 함수로 묻는다
  const usable = await client.usable();
  console.log(`  실집행 가능(usable)  ${usable}`);
  if (!usable) {
    console.log('\n✗ 관문에서 막혔습니다. 위 사유(스텁·낡음·카나리아·지문)를 보십시오.\n');
    process.exitCode = 1;
    return;
  }

  // ── 여기부터가 진짜 확인: 게시 경로가 쓰는 그 함수를 그대로 부른다 ──
  const ruleOnly = applyRules(input);
  const tier1 = await collectFirstTierFindings(input, { student: client });
  const fromStudent = tier1.all.filter((f) => f.source === 'student');

  console.log(`\n  시험 문장  "${PROBE}"`);
  console.log(`  규칙 단독  소견 ${ruleOnly.length}건  ${ruleOnly.length === 0 ? '(예상대로 — 금지어가 없다)' : '⚠ 예상 밖'}`);
  console.log(`  학생       소견 ${fromStudent.length}건`);
  for (const f of fromStudent) {
    console.log(`    · [${RISK_CATEGORY_LABEL[f.category]}] ${f.severity} — ${f.reason}`);
  }

  if (fromStudent.length > 0) {
    console.log('\n✓ **배선이 살아 있습니다.** 규칙이 못 잡는 문장을 학생이 잡아 게시가 보류됩니다.\n');
  } else {
    console.log(
      '\n✗ 학생이 아무 말도 안 했습니다. 사이드카는 멀쩡한데 소견이 안 나온다면\n' +
        '  졸업 라벨(STUDENT_ENABLED_LABELS)이나 임계값을 보십시오.\n',
    );
    process.exitCode = 1;
  }
}

main();
