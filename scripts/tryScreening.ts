import '@/server/db'; // Prisma Client 가 .env 를 process.env 에 얹는다 (학생 설정을 파일에서 읽기 위해)
import { readFileSync } from 'node:fs';
import {
  applyRules,
  decide,
  mergeFindings,
  resolveAction,
  RISK_CATEGORY_LABEL,
  type Finding,
} from '../src/domain/compliance';
import { createStudentClientFromEnv, studentMode } from '../src/infra/compliance/studentClient';
import { describeInput, parseReportFile } from './reportFile';

// **리포트를 직접 써 보고 검수가 뭐라고 하는지 본다.**
//
//   npx tsx scripts/tryScreening.ts my-report.txt
//
// ── 이 도구가 무엇인가 ──────────────────────────────────────────────
// 게시 경로가 쓰는 것과 **같은 함수**(applyRules · 학생 클라이언트 · decide ·
// resolveAction)를 그대로 부른다. 화면용으로 다시 구현하지 않는다 — 그러면 언젠가
// 둘이 갈라지고, 갈라지는 순간 이 도구는 이해를 돕는 게 아니라 오해를 만든다.
//
// **다르는 것은 두 가지뿐이다:**
//   ① 2차 AI 검수(Claude)는 부르지 않는다 — 운영에서 안 쓰기로 확정했다(7차)
//   ② 학습 표현 사전·의미 검색은 DB 를 봐야 해서 빼 뒀다 (사전이 비어 있으면 어차피 동일)
//
// 그래서 여기 나오는 결과는 **1차 검수의 결과**다. 실제 게시는 여기에 운영자 큐가
// 더 붙을 뿐, 거절·보류 여부는 이 값이 정한다.

const HELP = `
사용법:
  npx tsx scripts/tryScreening.ts <파일>

파일 형식 — 위는 카드, --- 아래는 본문:

  제목: 삼성전자 4분기 전망
  요약: 메모리 업황 개선을 예상합니다
  자산군: 국내주식
  종목: 삼성전자
  방향: 상승
  목표: 12%
  기간: 90일
  신뢰도: 5
  ---
  여기부터 본문입니다.
  여러 줄로 쓰셔도 됩니다.

카드 줄은 전부 생략할 수 있습니다(본문만 검사됩니다).
`;

function show(label: string, findings: Finding[]) {
  if (findings.length === 0) {
    console.log(`  ${label.padEnd(12)} 소견 없음`);
    return;
  }
  console.log(`  ${label.padEnd(12)} ${findings.length}건`);
  for (const f of findings) {
    const badge = f.severity === 'BLOCK' ? '위반' : '확인 필요';
    console.log(`      · [${badge} · ${RISK_CATEGORY_LABEL[f.category]}] ${f.reason}`);
    if (f.quote.trim()) console.log(`        인용: "${f.quote.trim()}"`);
  }
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const input = parseReportFile(readFileSync(path, 'utf-8'));
  console.log('\n═══ 검수 미리보기 ═══\n');
  console.log(describeInput(input));
  console.log('');

  // ── ① 결정적 규칙 — 즉시 거절 권한이 있는 유일한 탐지기 ──────────
  const ruleFindings = applyRules(input);
  const ruleDecision = decide(ruleFindings);

  // ── ② 학생 모델 — 규칙이 못 잡는 패러프레이즈를 메운다 ────────────
  const mode = studentMode();
  const client = mode === 'off' ? null : createStudentClientFromEnv();
  let studentFindings: Finding[] = [];
  let studentNote = '';
  if (!client) {
    studentNote = 'STUDENT_SIDECAR_URL 이 없어 학생이 돌지 않았습니다';
  } else if (mode !== 'live') {
    studentNote = `STUDENT_MODE=${mode} — 판정에 넣지 않습니다`;
  } else if (!(await client.usable())) {
    studentNote = '관문에서 막혔습니다 (사이드카가 떠 있습니까?)';
  } else {
    studentFindings = (await client.screen(input))?.findings ?? [];
  }

  show('규칙', ruleFindings);
  show('학생', studentFindings);
  if (studentNote) console.log(`      ※ ${studentNote}`);

  // ── ③ 합산 → 결정 → 처리 ─────────────────────────────────────────
  // **운영에서 실제로 노출되는 것은 합집합**이다(mergeFindings). 학생 단독만 보면
  // "둘이 서로 다른 정상 문장을 잘못 잡아 합산이 두 배가 되는" 경우를 놓친다.
  const all = mergeFindings(ruleFindings, studentFindings);
  const finalDecision = decide(all);
  const action = resolveAction(ruleDecision, finalDecision);

  const verdict = {
    PUBLISH: '게시됩니다 — 소견 없음',
    HOLD: '**게시 보류** — 운영자 큐로 갑니다. 승인되면 그때 게시됩니다',
    REJECT: '**즉시 거절** — 규칙이 잡은 명백한 위반입니다',
  }[action];

  console.log(`\n  ────────────────────────────────────────`);
  console.log(`  규칙 판정   ${ruleDecision}`);
  console.log(`  최종 판정   ${finalDecision}   (소견 ${all.length}건)`);
  console.log(`  처리        ${action} — ${verdict}\n`);

  if (action === 'REJECT') {
    console.log('  즉시 거절은 **규칙이 낸 BLOCK** 에만 있습니다 — 학생·AI 는 아무리');
    console.log('  확신해도 보류까지입니다. 오탐 하나가 정상 리포트를 죽이면 안 되니까요.\n');
  }
  console.log('  ※ 2차 AI 검수는 운영에서 쓰지 않으므로 여기 결과가 곧 실제 판정입니다.');
  console.log('  ※ 학습 표현 사전은 이 도구에서 빼 뒀습니다 (DB 조회가 필요해서).\n');
}

main();
