// ══════════════════════════════════════════════════════════════════════
// ⛔ 이 스크립트는 잠겼다 (2026-08-21 · 23차 Z-4 이행 중 발견)
//
// 손코퍼스는 **유일한 채점지**이고 학습 사용이 금지다 (17차 원칙 · 20차 X-4 표 확정).
// 그런데 이 스크립트가 채점지 전체를 학습 형식(train.v1.jsonl)으로 내보내고 있었다 —
// 다행히 현행 라이브 모델(synth-v2)의 학습 데이터에는 안 들어갔지만(out/student/
// config.json 의 data 목록으로 확인), 파일이 training/data/ 에 남아 있어 미래의
// --data data/*.jsonl 한 줄이 채점지를 통째로 삼킬 수 있었다. 23차 Z-4로 회귀 시드
// 17건까지 이 코퍼스에 살게 되면서 위험이 배가됐다.
//
// 학습 원천은 셋뿐이다: 합성(train:synth) · 창업자 수기(addTrainingCase) · 운영자 판정.
// training/data/train.v1.jsonl 과 teacher.v1.jsonl 은 지우는 것을 권한다.
// ══════════════════════════════════════════════════════════════════════
console.error(
  '⛔ train:export 는 잠겼습니다 — 손코퍼스는 채점지라 학습에 쓸 수 없습니다 (17차 · X-4 · 23차 Z-4).\n' +
    '   학습 자료는 train:synth(합성) / addTrainingCase(수기) / 운영자 판정으로만 만듭니다.',
);
process.exit(1);

import { mkdirSync, writeFileSync } from 'node:fs';
import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { corpusInput } from '../src/domain/screeningEval';
import {
  buildStudentText,
  isStudentLabel,
  STUDENT_LABELS,
  type TrainingExample,
} from '../src/domain/studentText';

// 학습셋 1차 원천 — 손코퍼스를 학생 모델 형식으로 내보낸다: npm run train:export
//
// 산출물:
//   training/data/train.v1.jsonl  손코퍼스 유래 학습 예시 (TrainingExample 한 줄씩)
//   training/data/labels.json     출력 벡터의 라벨 순서 — train.py가 이 파일을 읽는다.
//                                 순서를 코드 두 곳에 따로 적으면 어긋나는 날이 온다.
//
// **관측 전용(probe) 항목은 내보내지 않는다.** 정답을 모르는 항목에 라벨을 붙여 학습에
// 넣으면 그 임의의 판단을 모델이 배운다 — 평가에서 빼는 이유와 같다.
//
// 세 원천 중 나머지 둘은:
//   합성 확장   npm run train:synth (교사 라벨, ANTHROPIC_API_KEY 필요)
//   운영자 판정  출시 후 ComplianceReview.operatorVerdict에서 — 지금은 0건이라 없다

function toExample(
  item: (typeof SCREENING_CORPUS)[number],
  id: string,
): TrainingExample | null {
  if (item.probe) return null;
  if (item.violation !== null && !isStudentLabel(item.violation)) return null; // 학생 라벨 공간 밖
  return {
    id,
    source: 'hand_corpus',
    kind: item.kind,
    text: buildStudentText(corpusInput(item)),
    labels: item.violation === null ? [] : [item.violation],
    labeler: 'human',
  };
}

function main() {
  const examples = [
    ...SCREENING_CORPUS.map((item, i) => toExample(item, `sent:${i}`)),
    ...COHERENCE_CORPUS.map((item, i) => toExample(item, `doc:${i}`)),
  ].filter((e): e is TrainingExample => e !== null);

  mkdirSync('training/data', { recursive: true });
  writeFileSync(
    'training/data/train.v1.jsonl',
    examples.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  writeFileSync('training/data/labels.json', JSON.stringify(STUDENT_LABELS, null, 2) + '\n');

  const byKind = new Map<string, number>();
  for (const e of examples) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const positives = examples.filter((e) => e.labels.length > 0).length;

  console.log(`\ntraining/data/train.v1.jsonl — ${examples.length}건 (위반 ${positives} / 정상 ${examples.length - positives})`);
  for (const [kind, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(16)} ${n}건`);
  }
  console.log(
    '\n주의: 이 파일만으로는 학습에 부족합니다 (수백~수천 건 필요). 합성 확장은\n' +
      'npm run train:synth, 전체 절차는 training/README.md 를 보세요.\n',
  );
}

main();
