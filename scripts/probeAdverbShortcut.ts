import { buildStudentText } from '../src/domain/studentText';

// **부사 지름길·판정 역전 투명도 지표** (26차 CC-3 반증 조건 → 27차 DD-2 판정: 게이트 아님).
//
// 하드마진 대비쌍이 '반드시·결코·무조건·절대·기필코'류 부사를 담고 있으므로, 모델이
// 의미가 아니라 부사를 위반 신호로 외웠을 수 있다. 부사를 뺀 동의어 쌍으로 잰다.
//
// 27차 DD-2 확정 판정식: 절대값이 아니라 **스프레드(위반 − 정상) ≥ 0.4** 가 의미 학습의
// 증거다. 둘 다 0.7 위로 떠 버리면 점수 인플레이션이지 의미가 아니다.
// 반증(검토자): 핵심 명사를 무의미어로 바꿔도("원금"→"연필") 스프레드가 유지되면
// 의미가 아니라 그 쌍의 어순·구두점을 외운 것 — 그래서 치환 쌍을 함께 잰다.
//
// ⚠ **채택 게이트가 아니다.** 8문장짜리 미니 벤치를 게이트로 승격하면 그 8문장에
// 과적합한다(Y-4형). 투명도 지표로만 출력하고 exit 코드는 항상 0.
//
//   STUDENT_SIDECAR_URL=http://127.0.0.1:8766 npx tsx scripts/probeAdverbShortcut.ts

const BASE = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765';

const PAIRS: { violation: string; normal: string; nonsense: string }[] = [
  {
    violation: '원금은 제가 책임지고 지켜드립니다.',
    normal: '원금은 지켜드린다고 말할 수 없으니 유의하세요.',
    nonsense: '연필은 제가 책임지고 지켜드립니다.',
  },
  {
    violation: '확정 수익을 약속드릴 수 있습니다.',
    normal: '확정 수익을 약속드릴 수는 없습니다.',
    nonsense: '확정 구름을 약속드릴 수 있습니다.',
  },
  {
    violation: '손해 볼 일이 없는 자리입니다.',
    normal: '손해 볼 가능성은 언제나 있습니다.',
    nonsense: '모자 볼 일이 없는 자리입니다.',
  },
  {
    violation: '모든 손실은 전액 보전해 드립니다.',
    normal: '손실은 각자 감당하셔야 하는 몫입니다.',
    nonsense: '모든 바람은 전액 보전해 드립니다.',
  },
];

async function score(content: string, label = 'PROFIT_GUARANTEE'): Promise<number> {
  const text = buildStudentText({
    title: '', summary: '', content,
    assetClass: 'KR_EQUITY', assetName: '', direction: 'UP',
  } as never);
  const r = await fetch(`${BASE}/screen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, threshold: 0.01 }),
  });
  const j = (await r.json()) as { findings: { category: string; score: number }[] };
  return j.findings.find((f) => f.category === label)?.score ?? 0;
}

async function main() {
  console.log('쌍별 스프레드 (위반 − 정상) — 의미 학습의 증거는 ≥ 0.4 · 명사 치환 쌍은 낮아져야 함\n');
  let learned = 0;
  let memorized = 0;
  for (const p of PAIRS) {
    const v = await score(p.violation);
    const n = await score(p.normal);
    const x = await score(p.nonsense);
    const spread = v - n;
    const inverted = v < n;
    const nonsenseHeld = x >= 0.7 && spread >= 0.4; // 뜻 없는 문장이 여전히 위반이면 어순 암기 의심
    if (spread >= 0.4 && !nonsenseHeld) learned += 1;
    if (nonsenseHeld) memorized += 1;
    console.log(
      `${inverted ? '↕ 역전' : spread >= 0.4 ? '✓     ' : '·     '} 위반 ${v.toFixed(3)}  정상 ${n.toFixed(3)}  스프레드 ${spread >= 0 ? '+' : ''}${spread.toFixed(3)}  치환 ${x.toFixed(3)}${nonsenseHeld ? '  ⚠ 어순 암기 의심' : ''}`,
    );
    console.log(`        "${p.violation}"`);
  }
  console.log(`\n의미 학습 증거 ${learned}/${PAIRS.length}쌍 · 어순 암기 의심 ${memorized}쌍  (투명도 지표 — 채택 조건 아님)`);
  process.exit(0);
}
main();
