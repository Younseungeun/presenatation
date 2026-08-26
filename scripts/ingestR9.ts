import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { charBigramJaccard } from '../src/domain/textSimilarity';
import type { ScreeningInput } from '../src/domain/compliance';
import { buildStudentText, type StudentLabel, type TrainingExample } from '../src/domain/studentText';
import { SEMANTIC_PINGS } from '../src/infra/compliance/studentClient';

// **r9 접수 관문** (35차 LL-1 등록 절차 — README "r9" 절).
//
// gen:ingest 를 그대로 쓰지 않는 이유: 그 스크립트는 data/generated.jsonl(14M 시대의
// 학습 원천)에 덧붙이는데, r9 는 **110M 전용**이라 별도 파일(training/r9/)로 가야 한다
// (FF-4: 14M 재봉인 — r9 가 generated.jsonl 에 섞이면 봉인이 데이터 층에서 뚫린다).
// 검사는 gen:ingest 와 같은 것 + r9 등록분 셋을 더한다:
//   ① 형식·라벨(SOLICIT 만)·카드 필수  ② 채점지 유출(trigram ≥0.6)
//   ③ 쌍 자카드(위반문 bigram ≥0.6 — 뒤 쌍 드랍, 쌍 안은 면제: 하드마진은 원래 닮는다)
//   ④ 핑 오염(bigram ≥0.4)  ⑤ **r6 격리본 오염(bigram ≥0.4 — zero-shot 잣대 보호)**
//   ⑥ DART 근접 최대값 보고(정보)  ⑦ **60쌍 상한**(등록 규모 — 초과분은 예비로 격리)
//
//   npx tsx scripts/ingestR9.ts

const SRC = 'training/incoming-r9.jsonl';
const OUT = 'training/r9/generated.r9-solicit.jsonl';
const SURPLUS = 'training/r9/surplus.jsonl';
const MAX_PAIRS = 60; // @근거 계약 — 35차 LL-1 등록 규모 40~60쌍의 상한

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
function bodyOf(text: string): string {
  const i = text.indexOf('[본문]');
  return (i >= 0 ? text.slice(i + 4) : text).trim();
}

interface Row { content: string; direction: string; magnitudePct: number; horizonDays: number; confidence: number; labels: string[] }

function main() {
  const rows: Row[] = readFileSync(SRC, 'utf-8').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
  console.log(`받은 줄 ${rows.length}`);

  // 짝짓기: (위반, 정상) 인접 쌍 — 순서 어긋나면 보고
  const pairs: [Row, Row][] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const [a, b] = [rows[i]!, rows[i + 1]!];
    if (a.labels.length === 1 && a.labels[0] === 'SOLICIT_CONTACT' && b.labels.length === 0) pairs.push([a, b]);
    else console.log(`  ⚠ ${i + 1}행: 쌍 구조 어긋남 (라벨 ${JSON.stringify(a.labels)}/${JSON.stringify(b.labels)}) — 드랍`);
  }
  console.log(`쌍 ${pairs.length}개`);

  const judged = [...SCREENING_CORPUS.map((i) => i.text), ...COHERENCE_CORPUS.map((i) => i.text)].map(trigrams);
  const pings = SEMANTIC_PINGS.map((p) => p.input.content);
  const r6 = readFileSync('training/rejected/generated.r6-hardmargin.jsonl', 'utf-8')
    .split('\n').filter(Boolean).map((l) => bodyOf((JSON.parse(l) as { text: string }).text));
  const dart = readFileSync('training/holdout/control-dart-clean.jsonl', 'utf-8')
    .split('\n').filter(Boolean).map((l) => trigrams((JSON.parse(l) as { text: string }).text));

  const drops = new Map<string, number>();
  const drop = (why: string) => drops.set(why, (drops.get(why) ?? 0) + 1);
  const kept: [Row, Row][] = [];
  let dartWorst = 0;

  for (const pair of pairs) {
    const [v, n] = pair;
    if (!v.content?.trim() || !n.content?.trim() || v.magnitudePct == null || v.horizonDays == null) { drop('필드 누락'); continue; }
    const vt = trigrams(v.content); const nt = trigrams(n.content);
    if (judged.some((j) => jaccard(vt, j) >= 0.6 || jaccard(nt, j) >= 0.6)) { drop('채점지와 중복'); continue; }
    if (pings.some((p) => charBigramJaccard(v.content, p) >= 0.4 || charBigramJaccard(n.content, p) >= 0.4)) { drop('핑 근접(≥0.4)'); continue; }
    if (r6.some((b) => charBigramJaccard(v.content, b) >= 0.4 || charBigramJaccard(n.content, b) >= 0.4)) { drop('r6 격리본 근접(≥0.4)'); continue; }
    // 쌍 간 유사도: 위반문끼리 bigram ≥0.6 이면 뒤 쌍 드랍 (문형 반복 방지 — 쌍 안은 면제)
    let dup = false;
    for (const prev of kept) {
      if (charBigramJaccard(v.content, prev[0].content) >= 0.6) { dup = true; break; }
    }
    if (dup) { drop('쌍 자카드(위반문 ≥0.6)'); continue; }
    for (const d of dart) dartWorst = Math.max(dartWorst, jaccard(vt, d));
    kept.push(pair);
  }

  console.log(`\n관문 통과 ${kept.length}쌍`);
  for (const [why, c] of drops) console.log(`  드랍 ${c}쌍  ${why}`);
  console.log(`DART 근접 최대 (trigram): ${dartWorst.toFixed(3)} (정보 — 공시 산문과의 거리)`);

  const used = kept.slice(0, MAX_PAIRS);
  const surplus = kept.slice(MAX_PAIRS);
  console.log(`등록 상한 적용: 사용 ${used.length}쌍 · 예비 격리 ${surplus.length}쌍`);

  const examples: TrainingExample[] = [];
  let no = 0;
  for (const [v, n] of used) {
    for (const r of [v, n]) {
      no += 1;
      const input: ScreeningInput = {
        title: '', summary: '', content: r.content,
        assetClass: 'KR_EQUITY', assetName: '',
        direction: r.direction === 'DOWN' ? 'DOWN' : 'UP',
        targetType: 'RETURN_PCT', magnitudePct: r.magnitudePct,
        horizonDays: r.horizonDays, confidence: r.confidence,
      };
      examples.push({
        id: `gen:conversation-claude-r9:${no}`,
        source: 'founder', kind: 'generated',
        text: buildStudentText(input),
        labels: r.labels as StudentLabel[],
        labeler: 'external:conversation-claude-r9',
      });
    }
  }
  mkdirSync('training/r9', { recursive: true });
  writeFileSync(OUT, examples.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  writeFileSync(SURPLUS, surplus.map(([v, n]) => JSON.stringify(v) + '\n' + JSON.stringify(n)).join('\n') + (surplus.length ? '\n' : ''), 'utf-8');
  console.log(`\n→ ${OUT} (${examples.length}문장 = ${used.length}쌍)`);
  console.log(`→ ${SURPLUS} (예비 ${surplus.length}쌍 — 학습에 쓰지 않음, 이후 라운드 재료)`);
}
main();
