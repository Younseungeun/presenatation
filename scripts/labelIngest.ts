import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import { STUDENT_LABELS, type StudentLabel, type TrainingExample } from '../src/domain/studentText';

// 대화 교사 경로 — 답안 검증·병합: npm run label:ingest -- <답안파일...>
//
// 대화에서 받은 답안(JSONL)을 검증해 training/data/teacher.v1.jsonl 로 병합한다.
// **검증이 이 스크립트의 존재 이유다.** 사람이 붙여넣는 경로라 API 경로에는 없던
// 사고가 생긴다 — id 오타, 라벨 오탈자, 항목 누락, 같은 id 중복 답안. 그대로 학습에
//들어가면 원인을 찾을 수 없는 성능 저하로만 나타나므로 여기서 전부 막는다.
//
// 라벨은 항상 마지막 답안이 이긴다 (재라벨링이 가능해야 오탐 사례를 고칠 수 있다).

const MANIFEST = 'training/labeling/manifest.json';
const OUT = 'training/data/teacher.v1.jsonl';

/**
 * 라벨 출처 표식.
 *
 * 2차 검토 H-2에서 "대화 라벨은 기준선이 될 수 없다"고 못 박았는데, **그 규칙이 과했다**
 * (2026-08-19 재확정). 막으려던 것은 "대화"가 아니라 **오염** — 라벨링한 세션이 코퍼스
 * 원본(정답이 함께 적혀 있다)을 이미 읽은 상태였던 것이다. 그 조건은 없앨 수 있다:
 * **저장소 접근이 없는 새 창은 코퍼스 파일을 읽을 방법이 아예 없다.**
 *
 * 그래서 둘을 가른다. **기본값이 안전한 쪽(오염 가정)**이고, 깨끗하다고 선언하려면
 * `--clean-session`을 명시해야 한다 — 실수의 방향이 "덜 인정"이지 "잘못 인정"이 아니다.
 * 이 판단은 사람만 할 수 있지만(그 창이 저장소를 봤는지), 적어도 **아무것도 안 하면
 * 기준선으로 안 쓰인다.**
 */
const LABELER_DIRTY = 'conversation:claude-opus-5';
const LABELER_CLEAN = 'conversation-clean:claude-opus-5';

interface ManifestEntry {
  text: string;
  kind: string;
  origin: 'corpus' | 'candidate';
  intended: StudentLabel | null;
}

interface Answer {
  id: string;
  labels: string[];
}

function parseAnswers(paths: string[]): { answers: Map<string, string[]>; errors: string[] } {
  const answers = new Map<string, string[]>();
  const errors: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      errors.push(`파일 없음: ${path}`);
      continue;
    }
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // 대화에서 코드블록째 복사되는 일이 흔하다 — 울타리는 조용히 건너뛴다
      if (!trimmed || trimmed.startsWith('```')) return;
      let parsed: Answer;
      try {
        parsed = JSON.parse(trimmed) as Answer;
      } catch {
        errors.push(`${path}:${i + 1} JSON 파싱 실패 — ${trimmed.slice(0, 60)}`);
        return;
      }
      if (typeof parsed.id !== 'string' || !Array.isArray(parsed.labels)) {
        errors.push(`${path}:${i + 1} id·labels 형식 오류`);
        return;
      }
      if (answers.has(parsed.id)) {
        // 중복은 오류가 아니라 재라벨링이다. 다만 조용히 덮으면 안 되므로 알린다
        console.log(`  · ${parsed.id} 답안이 갱신되었습니다 (마지막 답안 채택)`);
      }
      answers.set(parsed.id, parsed.labels);
    });
  }
  return { answers, errors };
}

function main() {
  const argv = process.argv.slice(2);
  const paths = argv.filter((a) => !a.startsWith('--'));
  const clean = argv.includes('--clean-session');
  const LABELER = clean ? LABELER_CLEAN : LABELER_DIRTY;
  if (paths.length === 0) {
    console.log(
      '\n사용법: npm run label:ingest -- [--clean-session] training/labeling/answers-1.jsonl [...]\n\n' +
        '  --clean-session : 저장소를 본 적 없는 새 창에서 라벨링한 경우에만 붙입니다.\n' +
        '                    그 라벨만 교사 기준선으로 인정됩니다. 안 붙이면 학습 전용입니다.\n',
    );
    return;
  }
  if (!existsSync(MANIFEST)) {
    console.error(`${MANIFEST} 없음 — npm run label:pack 을 먼저 실행하세요`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, ManifestEntry>;
  const { answers, errors } = parseAnswers(paths);

  const valid = new Set<string>(STUDENT_LABELS);
  const examples: TrainingExample[] = [];
  const disagreements: { id: string; entry: ManifestEntry; got: StudentLabel[] }[] = [];

  for (const [id, labels] of answers) {
    const entry = manifest[id];
    if (!entry) {
      errors.push(`매니페스트에 없는 id: ${id}`);
      continue;
    }
    const bad = labels.filter((l) => !valid.has(l));
    if (bad.length > 0) {
      errors.push(`${id} 허용되지 않는 라벨: ${bad.join(', ')}`);
      continue;
    }
    // 바깥의 clean(세션이 깨끗한가)과 이름이 겹치면 안 된다 — 뜻이 완전히 다르다
    const uniq = [...new Set(labels)] as StudentLabel[];
    examples.push({
      id,
      source: entry.origin === 'corpus' ? 'hand_corpus' : 'synthetic',
      kind: entry.kind,
      text: entry.text,
      labels: uniq,
      labeler: LABELER,
    });
    const agrees = entry.intended ? uniq.includes(entry.intended) : uniq.length === 0;
    if (!agrees) disagreements.push({ id, entry, got: uniq });
  }

  if (errors.length > 0) {
    console.error(`\n검증 실패 ${errors.length}건 — 아무것도 저장하지 않았습니다:`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }

  writeFileSync(OUT, examples.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const missing = Object.keys(manifest).filter((id) => !answers.has(id));
  const positives = examples.filter((e) => e.labels.length > 0).length;
  console.log(
    `\n${OUT} — ${examples.length}건 (위반 ${positives} / 정상 ${examples.length - positives})`,
  );
  console.log(
    clean
      ? '출처: 깨끗한 세션 — **교사 기준선으로 인정됩니다.**'
      : '출처: 오염 가능 세션 — 학습 전용입니다. 기준선으로 쓰려면 저장소를 본 적 없는\n' +
        '      새 창에서 다시 라벨링하고 --clean-session 을 붙이세요.',
  );
  console.log(
    `진행률 ${examples.length}/${Object.keys(manifest).length}` +
      (missing.length > 0 ? ` — 남은 ${missing.length}건: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}` : ' — 전부 완료 ✓'),
  );

  if (disagreements.length > 0) {
    console.log(
      `\n[교사 ↔ 기존 라벨 불일치 ${disagreements.length}건]\n` +
        '  손코퍼스 항목이면 이것이 곧 **교사의 오탐·미탐**입니다 (사람 라벨이 정답).\n' +
        '  합성 후보면 생성이 빗나갔거나 교사가 틀렸거나 둘 중 하나이며, 라벨은 교사 판정을 따릅니다.',
    );
    for (const { id, entry, got } of disagreements) {
      const want = entry.intended ? RISK_CATEGORY_LABEL[entry.intended] : '정상';
      const g = got.length ? got.map((l) => RISK_CATEGORY_LABEL[l]).join(', ') : '정상';
      const head = entry.text.split('\n').pop()?.slice(0, 70) ?? '';
      console.log(`  · [${id}] ${head}\n      기존 ${want} → 교사 ${g}`);
    }
  }

  console.log(
    '\n다음: npm run eval:teacher -- --from ' + OUT + '   (교사 기준선 = 증류 천장)\n',
  );
}

main();
