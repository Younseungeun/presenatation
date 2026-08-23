import { readFileSync } from 'node:fs';
import { join } from 'node:path';


// **부정 창 `{0,N}` 의 N 을 실측으로 뽑는다** (19차 W-4 · "먼저 재야 할 것").
//
// 8 은 내가 고른 값이고 유도한 적이 없다. 검토의 지시:
//   "타겟 명사와 부정어가 함께 등장하는 문장을 필터링해 두 단어 사이의 글자 수 분포를
//    뽑아내라. 이 최대값이 N 이 되어야 한다."
//
// ── 함께 재는 것: 종결어미 패턴의 커버리지 (W-1) ─────────────────────
// 검토는 나열식 목록을 버리고 **어간 + 종결어미**로 압축하라고 했다. 그 압축이 실제
// 문장을 얼마나 덮는지 같은 코퍼스에서 잰다 — "몇 수 뒤에 있는지"의 답이다.

const HAND = join(process.cwd(), 'training', 'data', 'teacher.v1.jsonl');
const CONTROL = join(process.cwd(), 'training', 'holdout', 'control-hand.jsonl');

/**
 * 타겟 — 규칙이 잡는 **개념의 핵심 명사**.
 *
 * `RULES` 를 직접 쓰지 않는 이유: 그 표는 비공개다(금지 목록이 새면 리서처가 규칙을
 * 이진 탐색한다). 재려는 것은 "위반 낱말과 부정어 사이의 거리"이므로 핵심 명사면 충분하다.
 */
const TARGETS: { id: string; re: RegExp }[] = [
  { id: '원금·수익 보장', re: /(원금|수익|이익)\s*보장|손실\s*(보전|보상)|확정\s*수익/ },
  { id: '외부 채널', re: /카카오\s*톡|카톡|텔레그램|오픈\s*채팅|리딩\s*방|1\s*:\s*1\s*상담/ },
  { id: '미공개 정보', re: /내부\s*(관계자|정보)|미공개\s*(정보|공시)/ },
  { id: '풍문', re: /카더라|찌라시|소문/ },
  { id: '위험 투자', re: /빚투|풀\s*매수|영끌|올인|몰빵/ },
];

/** 부정 어간 — 활용은 종결어미가 맡는다 */
const NEG_STEM = /(아니|않|못\s*[하합]|없|불가|어렵|어려|힘[들듭든]|금지|위법|불법|배제)/g;

/**
 * 검토가 제안한 압축형: 어간 + (3자 이내) + 종결어미.
 * 나열식 목록이 존댓말에서 죽는 것을 이 꼬리가 덮는다.
 */
const NEG_COMPRESSED =
  /(아니|않|못\s*[하합]|없|불가|어렵|어려|힘[들듭든])[^,.!?\n]{0,3}(습니|ㅂ니|니다|다|까|요|죠|음|기|운|은|는|어|아|지)/;

/** 나열식(현행) — 압축형과 비교할 대상 */
const NEG_LIST = /(않|못\s*[하합]|없|아니|아닙|금지|위법|불법|배제|불가|어렵|어려|힘[들듭든])/;

interface Row {
  text: string;
  /** 규칙이 잡은 자리의 끝 인덱스 */
  matchEnd: number;
  rule: string;
  /** 그 뒤 가장 가까운 부정 어간까지의 글자 수 */
  gap: number;
  negWord: string;
  /** 사이에 쉼표가 있는가 — 검토가 지목한 장벽 후보 */
  commaBetween: boolean;
  /** **이 문장이 위반인가** — 이걸 안 가르면 N 을 위반 문장이 밀어 올린다 */
  violation: boolean;
}

/**
 * **라벨을 함께 싣는다.**
 *
 * 검토는 "타겟과 부정어 사이 글자 수의 **최대값** + 1"을 N 으로 쓰라고 했다.
 * 그대로 하면 안 된다 — 그 최대값을 만드는 문장이 **위반**일 수 있기 때문이다:
 *
 *   "이 종목은 원금 보장이 되는 구조라 손해 볼 일이 **없습니다**"   ← PROFIT_GUARANTEE
 *
 * 여기서 `없`은 주장을 무르는 부정이 아니라 **주장을 강화하는 말**이다. 이 gap 을 넣어
 * N 을 정하면 창이 넓어지면서 **바로 이 문장을 침묵시킨다.**
 *
 * 그래서 두 분포를 따로 낸다:
 *   정상 문장의 gap → 덮어야 하는 범위 (N 의 하한)
 *   위반 문장의 gap → 덮으면 안 되는 범위 (N 의 상한)
 * 두 분포가 겹치면 **N 으로는 못 가른다**는 것이 답이다.
 */
function load(): { text: string; violation: boolean }[] {
  const out: { text: string; violation: boolean }[] = [];
  for (const line of readFileSync(HAND, 'utf-8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { text: string; labels: string[] };
    out.push({ text: r.text, violation: r.labels.length > 0 });
  }
  for (const line of readFileSync(CONTROL, 'utf-8').split('\n').filter(Boolean)) {
    out.push({ text: (JSON.parse(line) as { text: string }).text, violation: false });
  }
  return out;
}

function main() {
  const texts = load();
  const rows: Row[] = [];
  let sentencesWithNeg = 0;
  let coveredByCompressed = 0;
  let coveredByList = 0;

  for (const { text, violation } of texts) {
    const hasNeg = NEG_LIST.test(text) || NEG_COMPRESSED.test(text);
    if (hasNeg) {
      sentencesWithNeg += 1;
      if (NEG_COMPRESSED.test(text)) coveredByCompressed += 1;
      if (NEG_LIST.test(text)) coveredByList += 1;
    }

    for (const target of TARGETS) {
      const g = new RegExp(target.re.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = g.exec(text)) !== null) {
        const end = m.index + m[0].length;
        const sentence = text.slice(end).split(/[.!?\n]/)[0] ?? '';
        NEG_STEM.lastIndex = 0;
        const hit = NEG_STEM.exec(sentence);
        if (hit) {
          rows.push({ text, matchEnd: end, rule: target.id, gap: hit.index, negWord: hit[0],
            commaBetween: sentence.slice(0, hit.index).includes(','), violation });
        }
        if (m[0].length === 0) g.lastIndex += 1;
      }
    }
  }

  console.log(`\n문장 ${texts.length}건 (손코퍼스 86 + 대조군 54)`);
  console.log(`  부정 어휘가 든 문장 ${sentencesWithNeg}건`);
  console.log(`    나열식이 덮는 것   ${coveredByList}건`);
  console.log(`    압축형이 덮는 것   ${coveredByCompressed}건`);

  if (rows.length === 0) {
    console.log('\n규칙 매칭 + 부정어가 함께 있는 문장이 없습니다 — N 을 못 잽니다.\n');
    return;
  }

  const split = (v: boolean) =>
    rows.filter((r) => r.violation === v).map((r) => r.gap).sort((a, b) => a - b);
  const normal = split(false);
  const viol = split(true);
  const fmt = (g: number[]) =>
    g.length === 0
      ? '표본 없음'
      : `최소 ${g[0]}  중앙 ${g[Math.floor(g.length / 2)]}  최대 ${g[g.length - 1]}  (표본 ${g.length})`;
  console.log('\n규칙 매칭 뒤 부정어까지의 글자 수');
  console.log(`  정상 문장 (창이 덮어야 함)    ${fmt(normal)}`);
  console.log(`  위반 문장 (창이 덮으면 안 됨)  ${fmt(viol)}`);
  if (normal.length > 0 && viol.length > 0 && viol[0] <= normal[normal.length - 1]) {
    console.log('  → 두 분포가 겹친다 — 창 크기 N 하나로는 못 가른다');
  }

  console.log('\n[전 표본 — 먼 것부터]');
  for (const r of [...rows].sort((a, b) => b.gap - a.gap)) {
    console.log(
      `  ${r.violation ? '위반' : '정상'}  gap ${String(r.gap).padStart(2)} · ${r.negWord.padEnd(4)} "${r.text.replace(/\n/g, ' ').slice(28, 84)}"`,
    );
  }
  console.log('');
}

main();
