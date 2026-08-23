import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { ASSET_CLASSES, type AssetClass } from '../src/domain/constants';
import type { ScreeningInput } from '../src/domain/compliance';
import {
  buildStudentText,
  STUDENT_LABELS,
  type StudentLabel,
  type TrainingExample,
} from '../src/domain/studentText';

// **외부 AI에게 받은 학습 자료를 검증해서 들인다** (npm run gen:ingest).
//
//   npm run gen:ingest -- received.jsonl --from gpt-5
//   npm run gen:ingest -- received.jsonl --from gemini --dry-run
//
// ── 검증이 이 스크립트의 존재 이유다 ────────────────────────────────
// 사람이 붙여넣는 경로에는 API 경로에 없던 사고가 생긴다: 라벨 오탈자, 필드 누락,
// 코드펜스가 섞여 들어옴, 같은 문장 반복, **그리고 채점지 베끼기**.
// 그대로 학습에 들어가면 원인을 못 찾는 성능 저하로만 나타나므로 전부 여기서 막는다.
//
// ── 왜 출처를 남기는가 ──────────────────────────────────────────────
// `labeler: external:<이름>`. 나중에 그 AI의 라벨이 의심되면 `--exclude-labeler
// external:` 한 줄로 통째로 빼고 재학습할 수 있어야 한다 — **되돌릴 수 있어야 통로다.**
// 그리고 이 자료는 학습 전용이다: 우리가 정의를 주고 받은 답이라 채택선으로 쓸 수 없다.

const OUT = 'training/data/generated.jsonl';

/** @근거 계약 — trainSynthCorpus·addTrainingCase 와 **같은 값**이어야 한다. 다르면 한쪽만 샌다 */
const LEAK_THRESHOLD = 0.6;
/** @근거 설계 — 받은 자료끼리도 겹치면 데이터가 아니라 반복이다. 채점지보다 느슨하게 둔다 */
const DUP_THRESHOLD = 0.8;

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

interface Row {
  title?: string;
  summary?: string;
  assetClass?: string;
  assetName?: string;
  direction?: string;
  magnitudePct?: number;
  horizonDays?: number;
  confidence?: number;
  content?: string;
  labels?: string[];
  kind?: string;
  note?: string;
}

function main() {
  const file = process.argv[2];
  const fromAt = process.argv.indexOf('--from');
  const from = fromAt >= 0 ? process.argv[fromAt + 1] : null;
  const dry = process.argv.includes('--dry-run');

  if (!file || !from) {
    console.log(`
사용법:
  npm run gen:ingest -- <받은파일.jsonl> --from <어느AI인지> [--dry-run]

  --from 은 반드시 적으십시오. 나중에 그 출처만 빼고 재학습해야 할 수 있습니다.
  --dry-run 이면 검사만 하고 쓰지 않습니다.
`);
    process.exitCode = 1;
    return;
  }

  const judged = [...SCREENING_CORPUS.map((i) => i.text), ...COHERENCE_CORPUS.map((i) => i.text)].map(
    trigrams,
  );

  const raw = readFileSync(file, 'utf-8').split('\n');
  const accepted: TrainingExample[] = [];
  const seen: Set<string>[] = [];
  const rejects = new Map<string, number>();
  const reject = (why: string) => rejects.set(why, (rejects.get(why) ?? 0) + 1);

  let lineNo = 0;
  for (const line of raw) {
    lineNo += 1;
    const t = line.trim();
    // 코드펜스·설명문이 섞여 오는 것은 흔한 일이라 조용히 건너뛴다
    if (!t || t.startsWith('```') || !t.startsWith('{')) continue;

    let r: Row;
    try {
      r = JSON.parse(t) as Row;
    } catch {
      reject('JSON 파싱 실패');
      continue;
    }

    if (!r.content?.trim()) {
      reject('본문 없음');
      continue;
    }
    const labels = r.labels ?? [];
    const bad = labels.filter((l) => !(STUDENT_LABELS as readonly string[]).includes(l));
    if (bad.length > 0) {
      reject(`모르는 라벨 (${bad.join(',')})`);
      continue;
    }
    if (r.assetClass && !(ASSET_CLASSES as readonly string[]).includes(r.assetClass)) {
      reject(`모르는 자산군 (${r.assetClass})`);
      continue;
    }

    const mine = trigrams(r.content);
    if (judged.some((j) => jaccard(mine, j) >= LEAK_THRESHOLD)) {
      reject('채점지와 중복');
      continue;
    }
    if (seen.some((s) => jaccard(mine, s) >= DUP_THRESHOLD)) {
      reject('받은 자료 안에서 중복');
      continue;
    }
    seen.push(mine);

    const input: ScreeningInput = {
      title: r.title ?? '',
      summary: r.summary ?? '',
      content: r.content,
      assetClass: (r.assetClass as AssetClass) ?? 'KR_EQUITY',
      assetName: r.assetName ?? '',
      direction: r.direction === 'DOWN' ? 'DOWN' : 'UP',
      // 카드가 비어 오면 채우지 않는다 — 비어 있다는 사실 자체가 12차 M-1 의 결함이라,
      // 여기서 조용히 메우면 "카드가 없는 예시"가 다시 학습셋에 들어온다
      targetType: r.magnitudePct != null ? 'RETURN_PCT' : undefined,
      magnitudePct: r.magnitudePct ?? null,
      horizonDays: r.horizonDays ?? null,
      confidence: r.confidence ?? null,
    };
    if (input.magnitudePct == null || input.horizonDays == null) {
      reject('예측 카드가 비어 있음 (목표·기간 필수)');
      continue;
    }

    accepted.push({
      id: `gen:${from}:${lineNo}`,
      source: 'founder', // 스키마상 외부 생성 자리가 따로 없다 — 구분은 labeler 가 한다
      kind: r.kind ?? 'generated',
      text: buildStudentText(input),
      labels: [...new Set(labels)] as StudentLabel[],
      labeler: `external:${from}`,
    });
  }

  // ── 받은 것의 모양을 보고한다 — 주문대로 왔는지는 사람이 봐야 안다 ──
  const byKind = new Map<string, number>();
  const byLabel = new Map<string, number>();
  let normals = 0;
  for (const e of accepted) {
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    if (e.labels.length === 0) normals += 1;
    for (const l of e.labels) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
  }

  console.log(`\n받은 줄 ${raw.length} → **채택 ${accepted.length}건**`);
  if (rejects.size > 0) {
    console.log('\n[거절]');
    for (const [why, n] of [...rejects.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}건  ${why}`);
    }
  }
  console.log('\n[종류별]');
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}건  ${k}`);
  }
  console.log('\n[라벨별]');
  for (const l of STUDENT_LABELS) console.log(`  ${String(byLabel.get(l) ?? 0).padStart(4)}건  ${l}`);
  console.log(`  ${String(normals).padStart(4)}건  (정상)`);

  const normalShare = accepted.length > 0 ? normals / accepted.length : 0;
  console.log(`\n정상 비율 ${(normalShare * 100).toFixed(0)}%`);
  if (normalShare < 0.35) {
    console.log(
      '  ⚠ **정상이 너무 적습니다.** 위반만 쌓으면 모델이 의심만 늘어 성실한 리서처를\n' +
        '    막게 됩니다. 주문서는 하드 네거티브 40% + 순수 정상 10% 를 요구합니다.',
    );
  }

  if (dry) {
    console.log('\n(--dry-run — 아무것도 쓰지 않았습니다)\n');
    return;
  }
  if (accepted.length === 0) {
    console.log('\n채택된 것이 없어 쓰지 않았습니다.\n');
    process.exitCode = 1;
    return;
  }

  mkdirSync('training/data', { recursive: true });
  const first = !existsSync(OUT);
  appendFileSync(OUT, accepted.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  const total = readFileSync(OUT, 'utf-8').trim().split('\n').length;
  console.log(`\n→ ${OUT} (${total}건)${first ? ' — 새 파일' : ''}`);
  console.log(`
재학습:
  cd training
  ../sidecar/.venv/Scripts/python.exe train.py \\
      --data data/synth.v2.jsonl data/generated.jsonl data/founder.jsonl --epochs 12
  ../sidecar/.venv/Scripts/python.exe export_onnx.py
  cd .. && npm run eval:student -- --sweep

의심되면 이 출처만 빼고 다시:
  train.py --data ... --exclude-labeler external:
`);
}

main();
