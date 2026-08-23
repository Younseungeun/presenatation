import { readFileSync } from 'node:fs';
import { buildStudentText } from '../src/domain/studentText';

// **문서 단위 오탐 게이트** (28차 EE-2 — 창 분할의 다중 비교 함정).
//
// 창을 N 번 이동하며 N 번 판정하면 문장 오탐률 p 가 문서 오탐률 1-(1-p)^N 으로 부푼다.
// DART 정제판 문장을 12개씩 묶은 정상 유사 문서에 창 채점(크기 W·보폭 1)을 걸어,
// 임계값별 **문서 오탐률**을 잰다 — 창 전용 임계값과 창 크기를 이 표로 정한다.
//
//   STUDENT_SIDECAR_URL=... npx tsx scripts/probeWindowDocFp.ts [--docs 150] [--window 2]

const BASE = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765';
const ENABLED = new Set(['PROFIT_GUARANTEE','PRIVATE_INFO','RUMOR','SOLICIT_CONTACT','UNSUPPORTED_CLAIM','RISK_INDUCEMENT','SCREENING_EVASION']);
const THRESHOLDS = [0.7, 0.8, 0.85, 0.9];

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

async function maxEnabled(content: string): Promise<number> {
  const text = buildStudentText({ title: '', summary: '', content, assetClass: 'KR_EQUITY', assetName: '', direction: 'UP' } as never);
  const r = await fetch(`${BASE}/screen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, threshold: 0.01 }) });
  const j = (await r.json()) as { findings: { category: string; score: number }[] };
  return Math.max(0, ...j.findings.filter((f) => ENABLED.has(f.category)).map((f) => f.score));
}

async function main() {
  const DOCS = Number(arg('docs') ?? '150');
  const W = Number(arg('window') ?? '2');
  const PER = 12;
  const dart = readFileSync('training/holdout/control-dart-clean.jsonl', 'utf-8').split('\n').filter(Boolean)
    .map((l) => (JSON.parse(l) as { text: string }).text);
  const docMax: number[] = [];
  for (let d = 0; d < DOCS; d += 1) {
    const sents = dart.slice(d * PER, d * PER + PER);
    if (sents.length < PER) break;
    let m = await maxEnabled(sents.join(' '));
    for (let i = 0; i + W <= sents.length; i += 1) {
      m = Math.max(m, await maxEnabled(sents.slice(i, i + W).join(' ')));
    }
    docMax.push(m);
    if ((d + 1) % 50 === 0) process.stdout.write(`\r  ${d + 1}/${DOCS}`);
  }
  console.log(`\n\n정상 유사 문서 ${docMax.length}건 · 창 ${W}문장 · 보폭 1 (창 ${PER - W + 1}개 + 통짜)`);
  for (const t of THRESHOLDS) {
    const fp = docMax.filter((m) => m >= t).length;
    console.log(`  t=${t.toFixed(2)}  문서 오탐 ${String(fp).padStart(3)}건  (${((fp / docMax.length) * 100).toFixed(2)}%)`);
  }
  process.exit(0);
}
main();
