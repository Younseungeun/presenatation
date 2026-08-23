import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { buildStudentText } from '../src/domain/studentText';
import { corpusInput } from '../src/domain/screeningEval';

// **부정어 지름길(shortcut) 실측** (23차 "먼저 재야 할 것" ①).
//
// 검토 주장: 학생이 "부정어 = 무조건 통과"라는 얕은 특징을 외웠다 — 그래서 부정형
// 위반("손해 볼 일이 없습니다")을 못 잡는다. 참이라면 부정형 **정상** 문장의 점수가
// 변별 없이 바닥(≈0)에 붙어 있어야 한다. 거짓이라면(중간대 점수) 모델은 부정을
// 나름 재고 있는 것이고, 처방(정상 문장만 합성)의 전제가 흔들린다.
//
// 실행: npx tsx scripts/probeNegationShortcut.ts  (사이드카 기동 필요)

const NEG = /않|없|말라|불가|어렵|아니|못\s|못한|못합/;

async function score(text: string): Promise<Map<string, number>> {
  const r = await fetch('http://127.0.0.1:8765/screen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, threshold: 0.01 }),
  });
  const j = (await r.json()) as { findings: { category: string; score: number }[] };
  return new Map(j.findings.map((f) => [f.category, f.score]));
}

function fmt(n: number) {
  return n.toFixed(2);
}

async function main() {
  const rows: { kind: string; text: string; max: number; top: string; pg: number }[] = [];
  for (const item of SCREENING_CORPUS) {
    if (!NEG.test(item.text)) continue;
    const s = await score(buildStudentText(corpusInput(item)));
    const entries = [...s.entries()].sort((a, b) => b[1] - a[1]);
    rows.push({
      kind: item.violation === null ? '정상' : `위반(${item.violation})`,
      text: item.text,
      max: entries[0]?.[1] ?? 0,
      top: entries[0]?.[0] ?? '-',
      pg: s.get('PROFIT_GUARANTEE') ?? 0,
    });
  }
  const normals = rows.filter((r) => r.kind === '정상');
  const viols = rows.filter((r) => r.kind !== '정상');
  console.log(`부정어 포함 문항: 정상 ${normals.length} · 위반 ${viols.length}\n`);
  console.log('── 부정형 정상 (지름길이면 전부 바닥 ≈0 이어야 함) ──');
  for (const r of normals) console.log(`  max ${fmt(r.max)} (${r.top})  "${r.text.slice(0, 40)}"`);
  console.log('\n── 부정형 위반 (모델이 잡아야 하는 것) ──');
  for (const r of viols) console.log(`  max ${fmt(r.max)} (${r.top})  [${r.kind}] "${r.text.slice(0, 40)}"`);
  const nMax = normals.map((r) => r.max);
  const vMax = viols.map((r) => r.max);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  console.log(
    `\n요약: 정상 평균 최고점 ${fmt(avg(nMax))} (min ${fmt(Math.min(...nMax))} · max ${fmt(Math.max(...nMax))})` +
      ` / 위반 평균 최고점 ${fmt(avg(vMax))} (min ${fmt(Math.min(...vMax))} · max ${fmt(Math.max(...vMax))})`,
  );
  process.exit(0);
}
main();
