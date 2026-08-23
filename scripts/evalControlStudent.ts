import { readFileSync } from 'node:fs';
import { buildStudentText } from '../src/domain/studentText';
import { DART_GATE_MAX_FP } from '../src/domain/dartProse';

// **학생의 실산문 오탐 내성** (23차 결론 → 26차 하드 게이트) — DART 정제판(v2 필터,
// N_clean=1,945)을 학생 단독으로 잰다. 기준: 오탐 ≤ DART_GATE_MAX_FP (Rule of Three).
// CARD_MISMATCH 도 그대로 채점한다 — 26차 실측(카드를 빼도 점수 불변)으로 "하네스
// 부작용" 가설이 기각됐고, 진짜 모순은 홀드아웃 5/5 로 잡는 과잉 일반화가 병명이다.
//   STUDENT_SIDECAR_URL=... npx tsx scripts/evalControlStudent.ts [--threshold 0.7]

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

async function main() {
  const threshold = Number(arg('threshold') ?? '0.7');
  const rows = readFileSync('training/holdout/control-dart-clean.jsonl', 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; text: string });

  let fp = 0;
  const byCat = new Map<string, { n: number; samples: string[] }>();
  let done = 0;
  for (const row of rows) {
    const text = buildStudentText({
      title: '', summary: '', content: row.text,
      assetClass: 'KR_EQUITY', assetName: '', direction: 'UP',
    });
    const r = await fetch(`${process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765'}/screen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, threshold }),
    });
    const j = (await r.json()) as { findings: { category: string; score: number }[] };
    done += 1;
    if (done % 500 === 0) process.stdout.write(`\r  ${done}/${rows.length}`);
    if (j.findings.length === 0) continue;
    fp += 1;
    for (const f of j.findings) {
      const slot = byCat.get(f.category) ?? { n: 0, samples: [] };
      slot.n += 1;
      if (slot.samples.length < 3) slot.samples.push(`${f.score.toFixed(2)} "${row.text.slice(0, 60)}"`);
      byCat.set(f.category, slot);
    }
  }
  console.log(`\n\n학생 단독 (t=${threshold}) — 정제판 ${rows.length}건 중 오탐 ${fp}건 (${((fp / rows.length) * 100).toFixed(2)}%)`);
  console.log(`게이트: 오탐 ${fp} ${fp <= DART_GATE_MAX_FP ? '≤' : '>'} ${DART_GATE_MAX_FP} → ${fp <= DART_GATE_MAX_FP ? '통과' : '실패'}`);
  if (fp > DART_GATE_MAX_FP) process.exitCode = 1;
  for (const [cat, s] of [...byCat.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${cat} ${s.n}건`);
    for (const smp of s.samples) console.log(`    ${smp}`);
  }
  process.exit(0);
}
main();
