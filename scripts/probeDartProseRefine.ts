import { readFileSync } from 'node:fs';
import { buildStudentText } from '../src/domain/studentText';

// 24차 "먼저 재야 할 것 ①" — DART 산문 정제 필터의 객관성과 모수(N_clean) 실측.
// 필터의 정의는 src/domain/dartProse.ts 에 **동결**돼 있다 (26차 BB-3(a)) — 여기서는
// 그 정의를 불러 재기만 한다. 정의를 여기 복제하면 언젠가 둘이 갈라진다.
import { isRefinedProse } from '../src/domain/dartProse';

async function main() {
  const threshold = 0.7;
  const rows = readFileSync('training/holdout/control-dart.jsonl', 'utf-8')
    .split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; text: string });

  const kept = rows.filter((r) => isRefinedProse(r.text));
  console.log(`DART 실산문: ${rows.length}건 → 정제판 N_clean = ${kept.length}건 (${((kept.length / rows.length) * 100).toFixed(1)}% 생존)`);
  console.log(`Rule of Three 기준값: 3/${kept.length} = ${((3 / kept.length) * 100).toFixed(3)}%`);

  // 반증 조건 실측 — 같은 필터에 채점지(손코퍼스)를 넣었을 때 시험지가 찢기는가
  const { SCORING_CORPUS } = await import('../src/domain/__fixtures__/screeningCorpus');
  const normals = SCORING_CORPUS.filter((c) => c.violation === null);
  const violations = SCORING_CORPUS.filter((c) => c.violation !== null);
  const nKeep = normals.filter((c) => isRefinedProse(c.text));
  const vKeep = violations.filter((c) => isRefinedProse(c.text));
  console.log(`\n채점지 생존율 — 정상 ${nKeep.length}/${normals.length}, 위반 ${vKeep.length}/${violations.length}`);
  for (const c of normals.filter((x) => !isRefinedProse(x.text)).slice(0, 8)) {
    console.log(`  [정상 탈락] ${c.text.slice(0, 50)}`);
  }
  for (const c of violations.filter((x) => !isRefinedProse(x.text)).slice(0, 8)) {
    console.log(`  [위반 탈락] ${c.text.slice(0, 50)}`);
  }

  // 정제판 위에서 학생(r5) 오탐 실측 — 기준값 3/N_clean 과 비교
  let fp = 0;
  const fpSamples: string[] = [];
  let done = 0;
  const queue = [...kept];
  async function worker() {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const text = buildStudentText({
        title: '', summary: '', content: row.text,
        assetClass: 'KR_EQUITY', assetName: '', direction: 'UP',
      });
      const r = await fetch('http://127.0.0.1:8765/screen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, threshold }),
      });
      const j = (await r.json()) as { findings: { category: string; score: number }[] };
      done += 1;
      if (done % 400 === 0) process.stdout.write(`\r  ${done}/${kept.length}`);
      if (j.findings.length > 0) {
        fp += 1;
        if (fpSamples.length < 10) {
          fpSamples.push(`${j.findings.map((f) => `${f.category}:${f.score.toFixed(2)}`).join(',')} "${row.text.slice(0, 70)}"`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`\n\n학생 r5 단독 (t=${threshold}) — 정제판 ${kept.length}건 중 오탐 ${fp}건 (${((fp / kept.length) * 100).toFixed(2)}%)`);
  console.log(`기준값 3/${kept.length} = ${((3 / kept.length) * 100).toFixed(3)}% → ${fp <= 3 ? '통과' : '초과'}`);
  for (const s of fpSamples) console.log(`  ${s}`);
  process.exit(0);
}
main();
