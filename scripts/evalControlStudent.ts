import { readFileSync } from 'node:fs';
import { buildStudentText } from '../src/domain/studentText';
import { DART_GATE_MAX_FP } from '../src/domain/dartProse';
import { DEFAULT_ENABLED_LABELS } from '../src/infra/compliance/studentClient';

// **학생의 실산문 오탐 내성** (23차 결론 → 26차 하드 게이트) — DART 정제판(v2 필터,
// N_clean=1,945)을 학생 단독으로 잰다. 기준: 오탐 ≤ DART_GATE_MAX_FP (Rule of Three).
//
// **게이트는 켜진 라벨만 센다** (32차 II-2 판정 — 외부 검토 확정). 게이트의 본질은
// "운영에 나갔을 때 사고를 치는가"인데, 영구 제외 라벨(CARD_MISMATCH — 512 절단으로
// 구조적 제외, studentClient DEFAULT_ENABLED_LABELS 주석)의 소견은 toFindings 에서
// 걸러져 **소견으로 나갈 수 없다.** 그 라벨의 오작동으로 배포를 막는 것은 맹장 검사다.
// 전 라벨 수치도 함께 찍는다 — 기준이 아니라 관측이다 (제외 라벨의 상태도 기록은 남긴다).
// 26차의 "CM 도 채점" 결정은 하네스 부작용 가설 기각까지였고, 게이트 기준은 이번에 바뀌었다.
// 소급: r5 실측 7건 = CM 3 + EVASION(표 조각) 4 → 켜진 라벨 4건 (여전히 >3 — CC-1 대로
// 채택 관문이지 소급 퇴출 장치가 아니므로 라이브 유지 판단 불변).
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

  const enabled = new Set<string>(DEFAULT_ENABLED_LABELS);
  let fpAll = 0;      // 어떤 라벨이든 소견이 난 문서 수 — 관측용
  let fpEnabled = 0;  // 켜진 라벨 소견이 난 문서 수 — **게이트는 이것만 본다**
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
    fpAll += 1;
    if (j.findings.some((f) => enabled.has(f.category))) fpEnabled += 1;
    for (const f of j.findings) {
      const slot = byCat.get(f.category) ?? { n: 0, samples: [] };
      slot.n += 1;
      if (slot.samples.length < 3) slot.samples.push(`${f.score.toFixed(2)} "${row.text.slice(0, 60)}"`);
      byCat.set(f.category, slot);
    }
  }
  console.log(`\n\n학생 단독 (t=${threshold}) — 정제판 ${rows.length}건 중 켜진 라벨 오탐 ${fpEnabled}건 (${((fpEnabled / rows.length) * 100).toFixed(2)}%) · 전 라벨 ${fpAll}건 (관측용)`);
  console.log(`게이트(켜진 라벨 L${enabled.size}): 오탐 ${fpEnabled} ${fpEnabled <= DART_GATE_MAX_FP ? '≤' : '>'} ${DART_GATE_MAX_FP} → ${fpEnabled <= DART_GATE_MAX_FP ? '통과' : '실패'}`);
  if (fpEnabled > DART_GATE_MAX_FP) process.exitCode = 1;
  for (const [cat, s] of [...byCat.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${cat} ${s.n}건${enabled.has(cat) ? '' : ' (영구 제외 라벨 — 게이트 밖)'}`);
    for (const smp of s.samples) console.log(`    ${smp}`);
  }
  process.exit(0);
}
main();
