import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { RISK_CATEGORY_LABEL, type RiskCategory } from '../src/domain/compliance';
import {
  buildStudentText,
  STUDENT_LABELS,
  type StudentLabel,
  type TrainingExample,
} from '../src/domain/studentText';
import { parseReportFile, describeInput } from './reportFile';

// **검수가 틀렸을 때, 그 리포트를 학습 자료로 넣는다** (12차 M-5).
//
//   npx tsx scripts/addTrainingCase.ts my-report.txt --violation PRIVATE_INFO
//   npx tsx scripts/addTrainingCase.ts my-report.txt --violation SOLICIT_CONTACT --violation CARD_MISMATCH
//   npx tsx scripts/addTrainingCase.ts my-report.txt --normal
//
// ── 이 통로가 왜 필요한가 ──────────────────────────────────────────
// 지금까지 학습 데이터의 출처는 둘뿐이었다: 손코퍼스(채점지라 학습 금지)와 합성 코퍼스.
// 둘 다 **책상에서 만든 문장**이라, 실제로 쓰다 만난 사례를 되먹일 자리가 없었다.
// 운영자 판정이 세 번째 원천이 될 예정이지만 그건 출시 후의 이야기다.
//
// 그 사이를 이 스크립트가 잇는다 — 창업자가 리포트를 써 보다 "이건 잡았어야 하는데"
// 또는 "이건 잡으면 안 되는데"를 만나면, 그 자리에서 학습 자료가 된다.
//
// ── 지켜야 하는 것 셋 ──────────────────────────────────────────────
// ① **채점지를 베끼지 않는다.** 손코퍼스와 겹치면 하네스 숫자가 무의미해진다(8차 결함).
//    합성 코퍼스와 같은 누출 가드를 여기서도 돌린다.
// ② **학습 전용이다.** 라벨을 붙인 사람이 곧 이 모델을 채택할 사람이라, 평가에 쓰면
//    자기가 낸 답안을 자기가 채점하는 것이 된다.
// ③ **카드까지 함께 넣는다.** 문장만 넣으면 12차 M-1 에서 고친 것을 다시 부순다 —
//    운영의 입력에는 언제나 카드가 있다.

const OUT = 'training/data/founder.jsonl';

/** @근거 설계 — trainSynthCorpus 의 누출 가드와 같은 값이어야 한다. 다르면 한쪽만 샌다 */
const LEAK_THRESHOLD = 0.6;

function trigrams(s: string): Set<string> {
  const t = s.replace(/[^가-힣a-zA-Z0-9]/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i += 1) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit += 1;
  return hit / (a.size + b.size - hit);
}

/**
 * **채점지와 겹치면 거절한다.**
 * 한국어는 조사가 붙어 단어 단위 비교가 "있었고"→"있었으며"를 놓친다. 글자 3-gram 이면
 * 잡힌다 — 합성 코퍼스가 같은 이유로 같은 방식을 쓴다.
 */
function assertNoLeak(text: string): void {
  const mine = trigrams(text);
  const judged = [
    ...SCREENING_CORPUS.map((i) => i.text),
    ...COHERENCE_CORPUS.map((i) => i.text),
  ];
  for (const other of judged) {
    const score = jaccard(mine, trigrams(other));
    if (score >= LEAK_THRESHOLD) {
      console.log(
        `\n✗ **채점지와 너무 비슷합니다** (유사도 ${(score * 100).toFixed(0)}%)\n` +
          `  겹치는 문장: "${other.slice(0, 60)}…"\n\n` +
          '  평가 코퍼스를 학습에 넣으면 하네스 숫자가 스스로를 채점하게 됩니다(8차 결함).\n' +
          '  다른 표현으로 바꿔서 다시 시도하십시오.\n',
      );
      process.exit(1);
    }
  }
}

function main() {
  const path = process.argv[2];
  const normal = process.argv.includes('--normal');
  // **여러 번 줄 수 있다.** 한 리포트에 위반이 하나뿐인 것이 오히려 드물다 —
  // 외부 채널 유도 + 본문·카드 모순 + 회피 시도가 한 문단에 같이 오는 것이 실제 모양이다.
  // 라벨을 하나만 받으면 나머지 위반이 **정상으로 학습된다**(다중 라벨 BCE라 빈 자리는
  // 곧 "아니다"라고 가르치는 것이다). 그게 이 통로에서 가장 조용한 사고다.
  const raws: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--violation' && process.argv[i + 1]) raws.push(process.argv[i + 1]);
  }

  if (!path || (!normal && raws.length === 0)) {
    console.log(`
사용법:
  npx tsx scripts/addTrainingCase.ts <파일> --violation <유형>   이건 위반인데 못 잡았다
  npx tsx scripts/addTrainingCase.ts <파일> --normal            이건 정상인데 잡았다

  --violation 은 여러 번 줄 수 있습니다 (한 리포트에 위반이 여럿이면 **전부** 적으십시오 —
  빠뜨린 유형은 '아니다'로 학습됩니다)

유형:
${STUDENT_LABELS.filter((l) => l !== 'CARD_MISMATCH')
  .map((l) => `  ${l.padEnd(20)} ${RISK_CATEGORY_LABEL[l as RiskCategory]}`)
  .join('\n')}
  CARD_MISMATCH        본문 결론과 예측 카드가 어긋남 (문서 단위)
`);
    process.exitCode = 1;
    return;
  }

  const unknown = raws.filter((r) => !(STUDENT_LABELS as readonly string[]).includes(r));
  if (unknown.length > 0) {
    console.log(`\n✗ 모르는 유형입니다: ${unknown.join(', ')}\n  (인자 없이 실행하면 목록이 나옵니다)\n`);
    process.exitCode = 1;
    return;
  }
  if (normal && raws.length > 0) {
    console.log('\n✗ --normal 과 --violation 을 함께 줄 수 없습니다. 둘 중 하나입니다.\n');
    process.exitCode = 1;
    return;
  }

  const input = parseReportFile(readFileSync(path, 'utf-8'));
  if (!input.content.trim()) {
    console.log('\n✗ 본문이 비어 있습니다.\n');
    process.exitCode = 1;
    return;
  }
  assertNoLeak(input.content);

  // 중복은 걷어낸다 — 같은 유형을 두 번 적어도 라벨은 하나다
  const labels = [...new Set(raws)] as StudentLabel[];
  const example: TrainingExample = {
    id: `founder:${Date.now()}`,
    source: 'founder',
    kind: normal ? 'founder_normal' : 'founder_violation',
    // **게시 경로와 같은 직렬화** — 여기서 다르게 만들면 조용히 틀린 것을 가르친다
    text: buildStudentText(input),
    labels,
    // 라벨을 붙인 주체를 남긴다. 나중에 이 출처만 빼고 재학습할 수 있어야 한다
    // (train.py --exclude-labeler) — 되먹임 통로는 되돌릴 수 있어야 통로다
    labeler: 'founder',
  };

  mkdirSync('training/data', { recursive: true });
  const first = !existsSync(OUT);
  appendFileSync(OUT, `${JSON.stringify(example)}\n`, 'utf-8');

  const n = readFileSync(OUT, 'utf-8').trim().split('\n').length;
  console.log(`\n${describeInput(input)}`);
  console.log(
    `\n✓ ${
      normal
        ? '**정상 사례**'
        : `**위반 사례** (${labels.map((l) => RISK_CATEGORY_LABEL[l as RiskCategory]).join(' + ')})`
    }로 넣었습니다 → ${OUT} (${n}건)${first ? ' — 새 파일' : ''}`,
  );
  console.log(`
다음 단계 (사례가 좀 쌓인 뒤에 한 번에 하십시오 — 한 건마다 재학습할 이유가 없습니다):

  cd training
  ../sidecar/.venv/Scripts/python.exe train.py --data data/synth.v2.jsonl data/founder.jsonl --epochs 12
  ../sidecar/.venv/Scripts/python.exe export_onnx.py
  cd .. && npm run eval:student -- --sweep      # 채택선을 다시 통과하는지

⚠ **채택선을 통과하지 못하면 배포하지 마십시오.** 사례 몇 건이 전체 성적을 깎을 수
  있습니다 — 그때 필요한 것은 더 넣는 것이 아니라 **왜 깎였는지 보는 것**입니다.
`);
}

main();
