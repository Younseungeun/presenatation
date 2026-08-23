import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { charBigramJaccard } from '../src/domain/textSimilarity';
import { SEMANTIC_PINGS } from '../src/infra/compliance/studentClient';

// **핑 오염 검사** (23차 Z-6 확정 — 학습 전처리 관문).
//
// 핑 문장 자체만 금지하면 합성기가 조사만 바꾼 이웃을 만들어 핑에 과적합한다.
// 학습 후보가 핑 문장과 자카드(글자 2-gram) ≥ 0.4 면 학습셋에서 드랍한다 —
// 0.4 는 22차 실측(자연 다름 max 0.323 / 복붙 min 0.400)의 재활용이다.
//
// 학습 자료를 만들 때마다 돌린다: npm run check:ping  (오염 발견 시 exit 1)

// 8문항 전부 — 정상 문항도 지킨다: 정상 핑과 닮은 학습 예시는 발작 감별의 눈금을 흐린다
const PING_TEXTS = SEMANTIC_PINGS.map((p) => p.input.content);
const CUTOFF = 0.4; // @근거 시뮬 — probePairDiversity (22차)

function bodyOf(text: string): string {
  const i = text.indexOf('[본문]');
  return (i >= 0 ? text.slice(i + 4) : text).trim();
}

function main() {
  // generated·founder 가 빠져 있었다 (2026-08-21 자체 발견 — 새 자료가 들어가는 파일이
  // 정작 검사 밖이었다). 학습 원천 전부를 훑는다
  const files = ['synth.v2.jsonl', 'synth.v1.jsonl', 'generated.jsonl', 'founder.jsonl', 'teacher.v1.jsonl', 'train.v1.jsonl'];
  let dirty = 0;
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(join(process.cwd(), 'training', 'data', f), 'utf-8');
    } catch {
      continue;
    }
    const rows = raw.split('\n').filter(Boolean);
    const hits: { id: string; sim: number; body: string }[] = [];
    for (const line of rows) {
      const r = JSON.parse(line) as { id: string; text: string };
      const body = bodyOf(r.text);
      for (const ping of PING_TEXTS) {
        const sim = charBigramJaccard(body, ping);
        if (sim >= CUTOFF) hits.push({ id: r.id, sim, body });
      }
    }
    console.log(`${f}: ${rows.length}건 중 핑 근접(≥${CUTOFF}) ${hits.length}건`);
    for (const h of hits) console.log(`  ${h.sim.toFixed(3)}  ${h.id}  "${h.body.slice(0, 40)}"`);
    dirty += hits.length;
  }
  if (dirty > 0) {
    console.log('\n✗ 핑 오염 — 위 항목을 학습셋에서 드랍한 뒤 학습하십시오.');
    process.exitCode = 1;
  } else {
    console.log('\n✓ 깨끗함 — 현재 시맨틱 핑 통과는 암기가 아니라 일반화다.');
  }
}
main();
