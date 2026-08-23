import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { corpusInput } from '../src/domain/screeningEval';
import { SYSTEM_PROMPT } from '../src/infra/compliance/claudeScreener';
import { STUDENT_LABELS, type StudentLabel } from '../src/domain/studentText';

// 대화 교사 경로 — 라벨링 팩 생성: npm run label:pack
//
// **왜 이 경로가 있는가.** 증류에는 교사 라벨이 필요한데, 교사를 API로 부르면 종량 과금이
// 붙는다. 이미 구독으로 쓰고 있는 대화형 Claude가 같은 판정을 내릴 수 있으므로, 사람이
// 붙여넣을 수 있는 형태로 문제지를 만들어 주고 답안을 파일로 되받는다.
//
// **핵심 제약 — 규정문을 복제하지 않는다.** 이 팩은 운영 어댑터의 SYSTEM_PROMPT를 그대로
// 가져다 쓴다. 규정을 여기 따로 적으면 프롬프트가 바뀔 때 조용히 어긋나고, 그러면 대화
// 교사와 API 교사의 라벨이 다른 기준에서 나와 섞이는 순간 학습셋이 오염된다.
//
// 흐름:
//   1) npm run label:pack -- --task label --source corpus   문제지 생성
//   2) 대화창에 팩을 붙여넣고 답안(JSONL)을 받아 training/labeling/answers-*.jsonl 로 저장
//   3) npm run label:ingest -- training/labeling/answers-1.jsonl   검증·병합
//
// 후보 문장을 새로 만들 때도 같은 방식이다 (--task generate → candidates.jsonl).

const DIR = 'training/labeling';
const MANIFEST = `${DIR}/manifest.json`;
const CANDIDATES = 'training/data/candidates.jsonl';

interface ManifestEntry {
  text: string;
  kind: string;
  /** 어디서 온 항목인가 — 손코퍼스(라벨 있음) / 합성 후보(생성 의도만 있음) */
  origin: 'corpus' | 'candidate';
  /** 손코퍼스의 사람 라벨 또는 후보의 생성 의도. 대조용이며 답안에 영향을 주면 안 된다 */
  intended: StudentLabel | null;
}

/** 팩에 실을 항목 하나의 본문 — 문서 항목은 카드·제목·요약까지 보여야 판정이 가능하다 */
function renderItem(id: string, entry: ManifestEntry): string {
  return `### [${id}]\n${entry.text}`;
}

function loadCorpusEntries(): Map<string, ManifestEntry> {
  const out = new Map<string, ManifestEntry>();
  SCREENING_CORPUS.forEach((item, i) => {
    if (item.probe) return; // 정답이 없는 관측 항목은 라벨을 붙이지 않는다
    out.set(`sent:${i}`, {
      // 문장 항목도 카드가 붙은 형태로 보여준다 — 하네스가 채우는 중립 카드와 같은 모습이라
      // 교사가 보는 것과 학생이 보게 될 입력이 어긋나지 않는다
      text: renderScreeningItem(item),
      kind: item.kind,
      origin: 'corpus',
      intended: (item.violation as StudentLabel | null) ?? null,
    });
  });
  COHERENCE_CORPUS.forEach((item, i) => {
    if (item.probe) return;
    out.set(`doc:${i}`, {
      text: renderScreeningItem(item),
      kind: item.kind,
      origin: 'corpus',
      intended: (item.violation as StudentLabel | null) ?? null,
    });
  });
  return out;
}

function renderScreeningItem(item: (typeof SCREENING_CORPUS)[number]): string {
  const input = corpusInput(item);
  const card: string[] = [`방향 ${input.direction === 'UP' ? '상승' : '하락'}`];
  if (input.targetType === 'TARGET_PRICE') card.push(`목표가 ${input.targetLabel ?? '-'}`);
  else if (input.magnitudePct != null) card.push(`목표 등락률 ${input.magnitudePct}%`);
  if (input.horizonDays != null) card.push(`시한 ${Math.round(input.horizonDays)}일`);
  if (input.confidence != null) card.push(`신뢰도 ${input.confidence}/10`);
  const parts = [`예측 카드: ${card.join(' / ')}`];
  if (input.title) parts.push(`제목: ${input.title}`);
  if (input.summary) parts.push(`요약: ${input.summary}`);
  parts.push(`본문: ${input.content}`);
  return parts.join('\n');
}

function loadCandidateEntries(): Map<string, ManifestEntry> {
  if (!existsSync(CANDIDATES)) {
    throw new Error(`${CANDIDATES} 없음 — 먼저 --task generate 로 후보를 만드세요`);
  }
  const out = new Map<string, ManifestEntry>();
  for (const line of readFileSync(CANDIDATES, 'utf8').split('\n').filter(Boolean)) {
    const c = JSON.parse(line) as { id: string; text: string; intended: StudentLabel | null };
    out.set(c.id, {
      text: `예측 카드: 방향 상승\n본문: ${c.text}`,
      kind: c.intended ? 'paraphrase' : 'hard_negative',
      origin: 'candidate',
      intended: c.intended,
    });
  }
  return out;
}

function writeLabelPacks(entries: Map<string, ManifestEntry>, batch: number) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(Object.fromEntries(entries), null, 2) + '\n');

  const ids = [...entries.keys()];
  const packs = Math.ceil(ids.length / batch);
  for (let p = 0; p < packs; p += 1) {
    const slice = ids.slice(p * batch, (p + 1) * batch);
    const body = slice.map((id) => renderItem(id, entries.get(id)!)).join('\n\n');
    const file = `${DIR}/pack-${p + 1}.md`;
    writeFileSync(
      file,
      `# 검수 라벨링 팩 ${p + 1}/${packs} — ${slice.length}건\n\n` +
        '아래 **규정**에 따라 각 항목을 판정하세요. 규정은 운영 검수 어댑터의 시스템\n' +
        '프롬프트 원본이며, 이 팩을 위해 고쳐 쓴 것이 아닙니다.\n\n' +
        '## 출력 형식 (반드시 이대로)\n\n' +
        '항목마다 JSONL 한 줄. 위반이 없으면 `labels`는 빈 배열입니다.\n' +
        '```\n{"id":"sent:0","labels":["PROFIT_GUARANTEE"]}\n{"id":"sent:1","labels":[]}\n```\n' +
        `허용 라벨: ${STUDENT_LABELS.join(' · ')}\n` +
        '(MISSING_DISCLOSURE·RISKY_INSTRUMENT 등 종목 데이터가 필요한 유형은 학생 라벨 공간\n' +
        '밖이라 쓰지 않습니다. 해당 소견만 있으면 빈 배열로 두세요.)\n\n' +
        '**심각도는 받지 않습니다** — AI 소견은 BLOCK이든 WARN이든 처리가 같고(보류),\n' +
        '평가 하네스도 유형만 봅니다. 판정에 쓸 정보를 줄이지 않으려고 규정은 원본 그대로 둡니다.\n\n' +
        `---\n\n<규정>\n${SYSTEM_PROMPT}\n</규정>\n\n---\n\n## 항목 ${slice.length}건\n\n${body}\n`,
      'utf8',
    );
    console.log(`  ${file} — ${slice.length}건`);
  }
  console.log(
    `\n${MANIFEST} 에 정답 대조용 정보를 저장했습니다 (팩에는 넣지 않습니다 — ` +
      '사람 라벨을 보여주면 교사가 그것을 따라가 독립적인 판정이 아니게 됩니다).\n' +
      '\n다음: 팩을 대화에 붙여넣고 받은 JSONL을 training/labeling/answers-N.jsonl 로 저장한 뒤\n' +
      '  npm run label:ingest -- training/labeling/answers-1.jsonl\n',
  );
}

function writeGeneratePack(perCategory: number) {
  mkdirSync(DIR, { recursive: true });
  const targets = STUDENT_LABELS.filter((l) => l !== 'CARD_MISMATCH');
  const sections = targets.map((category) => {
    const seeds = SCREENING_CORPUS.filter(
      (i) => i.violation === category && i.kind === 'paraphrase',
    )
      .slice(0, 3)
      .map((i) => `  - ${i.text}`)
      .join('\n');
    return `### ${category} — ${RISK_CATEGORY_LABEL[category]}\n기존 예시:\n${seeds || '  (없음)'}`;
  });

  const file = `${DIR}/generate-pack.md`;
  writeFileSync(
    file,
    `# 학습 데이터 생성 팩 — 유형별 ${perCategory}건씩\n\n` +
      '검수 학생 모델의 학습 데이터를 만듭니다. 아래 각 유형에 대해 **두 묶음**을 씁니다.\n\n' +
      `1. **위반 ${perCategory}건** — 그 유형에 해당하지만 금지 단어를 그대로 쓰지 않고\n` +
      '   돌려 말하는 문장 (패러프레이즈). 문체·화자·상황을 다양하게.\n' +
      `2. **하드 네거티브 ${perCategory}건** — 같은 유형과 **어휘가 겹치지만 위반이 아닌**\n` +
      '   문장. 부정문("~을 약속하지 않습니다"), 면책 문구, 그 주제의 평범한 분석을 섞을 것.\n' +
      '   무관한 정상 문장은 아무것도 가르치지 않으므로 쓰지 마세요.\n\n' +
      '## 출력 형식\n\n' +
      '```\n{"id":"synth:0","text":"…","intended":"PROFIT_GUARANTEE"}\n' +
      '{"id":"synth:1","text":"…","intended":null}\n```\n\n' +
      '`intended`는 **생성 의도**일 뿐 최종 라벨이 아닙니다 — 라벨은 다음 단계에서 같은\n' +
      '규정으로 다시 판정해 붙입니다. 그래야 학생이 배우는 것이 생성 의도가 아니라 검수 판정이 됩니다.\n\n' +
      `저장 위치: ${CANDIDATES}\n\n---\n\n${sections.join('\n\n')}\n`,
    'utf8',
  );
  console.log(
    `\n${file} 생성.\n대화에 붙여넣고 받은 JSONL을 ${CANDIDATES} 로 저장한 뒤:\n` +
      '  npm run label:pack -- --task label --source candidates\n',
  );
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const task = arg('--task') ?? 'label';

  if (task === 'generate') {
    writeGeneratePack(Number(arg('--n')) || 20);
    return;
  }
  const source = arg('--source') ?? 'corpus';
  const entries = source === 'candidates' ? loadCandidateEntries() : loadCorpusEntries();
  console.log(`\n항목 ${entries.size}건 → 라벨링 팩 생성`);
  writeLabelPacks(entries, Number(arg('--batch')) || 30);
}

main();
