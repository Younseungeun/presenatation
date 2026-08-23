import { SCORING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { corpusInput } from '../src/domain/screeningEval';
import { buildStudentText } from '../src/domain/studentText';

// **r5 의 위반 문항 점수 분포** (30차 먼저 재야 할 것 ③ — 소프트 라벨 뭉갬 가설의 산술).
// 채점지 위반 문항마다 정답 라벨의 r5 점수를 찍어 라벨별 중앙값·<0.5 비율을 낸다.
// 중앙값이 0.5 밑에 몰려 있으면, 교사의 소프트 라벨이 이 값을 0.8 로 끌어올리지 못하는 한
// 증류는 "뭉개는 법"을 가르친다 — 부검에서 110M 의 같은 분포와 나란히 놓을 기준선.
const BASE = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765';

async function main() {
  const by = new Map<string, number[]>();
  const normalsMax: number[] = [];
  for (const item of SCORING_CORPUS) {
    const r = await fetch(`${BASE}/screen`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: buildStudentText(corpusInput(item)), threshold: 0.01 }),
    });
    const j = (await r.json()) as { findings: { category: string; score: number }[] };
    const scores = new Map(j.findings.map((f) => [f.category, f.score]));
    if (item.violation) {
      const s = by.get(item.violation) ?? [];
      s.push(scores.get(item.violation) ?? 0);
      by.set(item.violation, s);
    } else {
      normalsMax.push(Math.max(0, ...scores.values()));
    }
  }
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
  console.log('라벨               n   중앙값  <0.5   ≥0.7');
  for (const [label, xs] of [...by.entries()].sort()) {
    console.log(`${label.padEnd(18)} ${String(xs.length).padStart(2)}  ${med(xs).toFixed(3)}  ${String(xs.filter((x) => x < 0.5).length).padStart(2)}/${xs.length}  ${String(xs.filter((x) => x >= 0.7).length).padStart(2)}/${xs.length}`);
  }
  console.log(`정상 ${normalsMax.length}건 최대점수 중앙값 ${med(normalsMax).toFixed(3)} · ≥0.5 ${normalsMax.filter((x) => x >= 0.5).length}건 · ≥0.7 ${normalsMax.filter((x) => x >= 0.7).length}건`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
