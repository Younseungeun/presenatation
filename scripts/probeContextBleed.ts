import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyRules } from '../src/domain/compliance';
import type { ScreeningInput } from '../src/domain/compliance';
import { assembleTeacherPack } from '../src/server/teacherPack';
import { isStudentLabel, type StudentLabel } from '../src/domain/studentText';

// **맥락 이월이 판정을 바꾸는가** (18차 V-6 · 검토가 지목한 "먼저 재야 할 것").
//
// ── 왜 이걸 재야 하나 ────────────────────────────────────────────────
// 자동 2차는 매 건이 독립 요청이라 이 문제가 원리적으로 없었다. 사람이 나르면 한
// 대화창에서 보류 건을 연속으로 묻게 되고, 앞 건의 판정이 뒤 건을 민다.
// 코드가 강제할 수 없는 자리라 **효과의 크기를 알아야** 처방의 무게를 정할 수 있다.
//
// ── 실험 설계 (검토안) ───────────────────────────────────────────────
//   대조군 ⓐ 같은 문항을 **매번 새 대화창**에서 판정
//   실험군 ⓑ 같은 문항을 **한 대화창에 연속으로** 붙여 넣어 판정
//   재는 것: 정답 대비 오탐·미탐이 ⓐ 대비 ⓑ에서 몇 %p 늘었는가
//
// ── 검토안에서 하나 바꾼 것, 그리고 그 이유 ─────────────────────────
// 검토는 "손코퍼스 86 + 신조어 127 = 213건"을 제안했다. **신조어 127건은 쓸 수 없다** —
// 그것은 문장이 아니라 `nm공정`·`bps금리` 같은 **토막**이고, 규칙의 토큰 판별을 재려고
// 만든 것이다. 리포트로 내밀면 교사는 두 조건 모두에서 "이건 리포트가 아닙니다"라고
// 답한다. 두 조건의 답이 같으니 이월을 **재지 못하면서 표본만 희석한다.**
//
// 대신 문장인 것으로 채운다: **손코퍼스 86(라벨 있음) + 대조군 54(정상)** = 140건.
// 라벨이 있어야 "판정이 바뀌었다"를 정답 대비로 셀 수 있고, 정상 문장이 섞여야
// 이월이 **엄해지는 쪽**인지 **느슨해지는 쪽**인지 방향이 나온다.

const OUT = join(process.cwd(), 'training', 'bleed');
const CARD = {
  assetClass: 'KR_EQUITY' as const,
  assetName: '삼성전자',
  direction: 'UP' as const,
  targetType: 'RETURN_PCT' as const,
  magnitudePct: 12,
  horizonDays: 90,
  confidence: 5,
};

interface Item {
  id: string;
  text: string;
  /** 정답 라벨. 빈 배열이면 정상 문장 */
  labels: StudentLabel[];
}

function loadItems(): Item[] {
  const items: Item[] = [];

  // ① 손코퍼스 86 — **유일한 채점지**(모델 학습 금지). 라벨이 있어 정답 대비로 셀 수 있다
  const hand = join(process.cwd(), 'training', 'data', 'teacher.v1.jsonl');
  for (const line of readFileSync(hand, 'utf-8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { id: string; text: string; labels: string[] };
    items.push({
      id: `hand:${r.id}`,
      text: r.text,
      labels: r.labels.filter((l): l is StudentLabel => isStudentLabel(l as never)),
    });
  }

  // ② 대조군 54 — 정상 문장. 이월이 **엄해지는 쪽**인지 방향을 준다
  const control = join(process.cwd(), 'training', 'holdout', 'control-hand.jsonl');
  for (const line of readFileSync(control, 'utf-8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { id: string; text: string };
    items.push({ id: `ctrl:${r.id}`, text: r.text, labels: [] });
  }
  return items;
}

function packFor(item: Item): string {
  const input: ScreeningInput = { title: '', summary: '', content: item.text, ...CARD };
  // **운영과 같은 1차 규칙을 태운다** — 질문지에 실리는 "1차가 짚은 것"이 달라지면
  // 재는 대상이 운영과 달라진다
  const findings = applyRules(input, {});
  return assembleTeacherPack({ packId: item.id, input, findings, corrections: [] }).text;
}

/** ⓐ·ⓑ 두 조건의 재료를 만든다 */
function generate() {
  const items = loadItems();
  mkdirSync(OUT, { recursive: true });

  // ⓐ 대조군: 한 건씩 — 매번 **새 대화창**에 하나만 붙여 넣는다
  const single = items.map((i) => ({ id: i.id, pack: packFor(i) }));
  writeFileSync(join(OUT, 'condition-a-fresh.json'), JSON.stringify(single, null, 2), 'utf-8');

  // ⓑ 실험군: 한 파일 — **한 대화창에** 위에서부터 차례로 붙여 넣는다
  const joined = single
    .map((s, n) => `<!-- ${n + 1}/${single.length} · 여기부터 다음 질문 -->\n\n${s.pack}`)
    .join('\n\n\n');
  writeFileSync(join(OUT, 'condition-b-sequential.md'), joined, 'utf-8');

  writeFileSync(
    join(OUT, 'answer-key.json'),
    JSON.stringify(items.map(({ id, labels }) => ({ id, labels })), null, 2),
    'utf-8',
  );

  const violations = items.filter((i) => i.labels.length > 0).length;
  console.log(`\n문항 ${items.length}건 (위반 ${violations} / 정상 ${items.length - violations})`);
  console.log(`  ⓐ ${join(OUT, 'condition-a-fresh.json')}`);
  console.log(`     → 각 pack 을 **새 대화창**에 하나씩. 답 JSONL 을 answers-a.jsonl 로 모은다`);
  console.log(`  ⓑ ${join(OUT, 'condition-b-sequential.md')}`);
  console.log(`     → **한 대화창**에 위에서부터 차례로. 답을 answers-b.jsonl 로 모은다`);
  console.log(`\n모았으면: npm run probe:bleed -- score\n`);
}

interface Scored {
  n: number;
  fp: number;
  fn: number;
  unreadable: number;
}

function scoreOne(answersPath: string, key: Map<string, StudentLabel[]>): Scored {
  const out: Scored = { n: 0, fp: 0, fn: 0, unreadable: 0 };
  for (const line of readFileSync(answersPath, 'utf-8').split('\n').filter((l) => l.trim())) {
    let r: { id?: string; labels?: unknown };
    try {
      r = JSON.parse(line);
    } catch {
      out.unreadable++;
      continue;
    }
    const truth = r.id ? key.get(r.id) : undefined;
    if (!truth || !Array.isArray(r.labels)) {
      out.unreadable++;
      continue;
    }
    out.n++;
    const said = (r.labels as string[]).filter((l): l is StudentLabel => isStudentLabel(l as never));
    // **결론 수준으로 센다** — 유형 하나 차이는 이월의 신호가 아니다
    if (truth.length === 0 && said.length > 0) out.fp++;
    if (truth.length > 0 && said.length === 0) out.fn++;
  }
  return out;
}

function score() {
  const key = new Map<string, StudentLabel[]>(
    (JSON.parse(readFileSync(join(OUT, 'answer-key.json'), 'utf-8')) as Item[]).map((i) => [
      i.id,
      i.labels,
    ]),
  );
  const paths = { a: join(OUT, 'answers-a.jsonl'), b: join(OUT, 'answers-b.jsonl') };
  for (const [k, p] of Object.entries(paths)) {
    if (!existsSync(p)) {
      console.log(`\n${p} 가 없습니다 — 조건 ${k} 의 답을 먼저 모아 주세요.\n`);
      return;
    }
  }
  const a = scoreOne(paths.a, key);
  const b = scoreOne(paths.b, key);

  const pct = (x: number, n: number) => (n > 0 ? (x / n) * 100 : 0);
  const row = (label: string, s: Scored) =>
    `  ${label.padEnd(22)} ${String(s.n).padStart(4)}건   오탐 ${pct(s.fp, s.n).toFixed(1)}%   미탐 ${pct(s.fn, s.n).toFixed(1)}%   못 읽음 ${s.unreadable}`;

  console.log('\n맥락 이월 실험 (18차 V-6)\n');
  console.log(row('ⓐ 매번 새 대화', a));
  console.log(row('ⓑ 한 대화 연속', b));

  const dFp = pct(b.fp, b.n) - pct(a.fp, a.n);
  const dFn = pct(b.fn, b.n) - pct(a.fn, a.n);
  console.log(`\n  차이: 오탐 ${dFp >= 0 ? '+' : ''}${dFp.toFixed(1)}%p · 미탐 ${dFn >= 0 ? '+' : ''}${dFn.toFixed(1)}%p`);

  // **표본이 답할 수 있는 것만 말한다.** 140건에서 정규근사 95% 구간의 반폭은
  // 대략 1.96·√(2·p(1−p)/n) 이다 — p≈0.1 이면 약 7%p. 그보다 작은 차이는
  // "차이가 없다"가 아니라 **"이 표본으로는 못 잰다"**이고, 둘은 다른 말이다
  const n = Math.min(a.n, b.n);
  const halfWidth = n > 0 ? 1.96 * Math.sqrt((2 * 0.1 * 0.9) / n) * 100 : Infinity;
  console.log(`  이 표본(${n}건)이 잡을 수 있는 최소 차이는 약 ${halfWidth.toFixed(1)}%p 입니다.`);
  if (Math.abs(dFp) < halfWidth && Math.abs(dFn) < halfWidth) {
    console.log(
      '  → 잰 차이가 그 아래입니다. **"이월이 없다"가 아니라 "이 표본으로는 못 잰다"** 입니다.\n',
    );
  } else {
    console.log(
      '  → 잰 차이가 그 위입니다. 새 대화 강제를 화면 안내가 아니라 **운영 규칙**으로 올리십시오.\n',
    );
  }
}

if (process.argv.includes('score')) score();
else generate();
