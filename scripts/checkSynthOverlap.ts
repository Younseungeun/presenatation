import { readFileSync } from 'node:fs';

// **합성 자료 ↔ DART 게이트 코퍼스 유출 검사** (26차 CC-2 확정 — 문체 모사의 경계).
//
// CARD_MISMATCH 대비쌍은 공시체 문체를 **모사**하되 게이트 문장을 **복제**하면 안 된다
// (게이트로 승격된 DART 정제판은 학습 금지). 판별식:
//   ① 어절 3-gram 중복 비율 > 30% → 드랍 (검토자 지정 상한 — 새로 지은 문장은
//      정제판과 겹치는 어절 3연쇄가 거의 없다. 겹침은 표절의 지문이다)
//   ② 정제판 문장을 통째로 포함 → 드랍 (완전 복제)
//
// 사용: npx tsx scripts/checkSynthOverlap.ts -- --file training/data/candidate.jsonl
//   (jsonl 각 행의 text 에서 [본문] 이후를 비교한다 — 카드·제목은 하네스 몫)

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

function bodyOf(text: string): string {
  const i = text.indexOf('[본문]');
  return (i >= 0 ? text.slice(i + 4) : text).trim();
}

function wordTrigrams(s: string): Set<string> {
  const words = s.split(/\s+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + 2 < words.length; i += 1) grams.add(words.slice(i, i + 3).join(' '));
  return grams;
}

const OVERLAP_CUTOFF = 0.3; // @근거 계약 — 26차 CC-2 검토자 지정 상한

function main() {
  const file = arg('file');
  if (!file) {
    console.log('사용: npx tsx scripts/checkSynthOverlap.ts -- --file <후보.jsonl>');
    process.exitCode = 1;
    return;
  }
  const dart = readFileSync('training/holdout/control-dart-clean.jsonl', 'utf-8')
    .split('\n').filter(Boolean)
    .map((l) => (JSON.parse(l) as { text: string }).text);
  const dartGrams = new Set<string>();
  for (const t of dart) for (const g of wordTrigrams(t)) dartGrams.add(g);

  const rows = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { id?: string; text: string });
  let dirty = 0;
  for (const r of rows) {
    const body = bodyOf(r.text);
    const grams = wordTrigrams(body);
    if (grams.size === 0) continue;
    let hit = 0;
    for (const g of grams) if (dartGrams.has(g)) hit += 1;
    const ratio = hit / grams.size;
    const contained = dart.find((t) => body.includes(t) || t.includes(body));
    if (ratio > OVERLAP_CUTOFF || contained) {
      dirty += 1;
      console.log(
        `✗ ${r.id ?? '?'}  3-gram ${(ratio * 100).toFixed(0)}%${contained ? ' · 통째 포함' : ''}  "${body.slice(0, 50)}"`,
      );
    }
  }
  console.log(`\n${rows.length}건 중 유출 의심 ${dirty}건 (어절 3-gram > ${OVERLAP_CUTOFF * 100}% 또는 통째 포함)`);
  if (dirty > 0) {
    console.log('✗ 위 항목을 드랍한 뒤 학습하십시오 — 게이트 문장 복제는 벤치 오염입니다.');
    process.exitCode = 1;
  } else {
    console.log('✓ 깨끗함 — 문체만 빌렸고 문장은 새로 지었습니다.');
  }
}
main();
