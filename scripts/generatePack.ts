import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import { SYSTEM_PROMPT } from '../src/infra/compliance/claudeScreener';
import { STUDENT_LABELS } from '../src/domain/studentText';

// **외부 AI에게 학습 자료를 대량으로 받기 위한 주문서를 만든다** (npm run gen:pack).
//
// ── 왜 정적 문서로 안 쓰는가 ────────────────────────────────────────
// ① **규정문을 베끼지 않는다.** 위반 유형 정의는 운영 어댑터의 SYSTEM_PROMPT에서
//    그대로 끌어온다. 여기 따로 적으면 프롬프트가 바뀌는 날 외부 AI만 옛 기준으로
//    만들게 되고, 그 자료는 **다른 시험을 보고 온 답안**이 된다 (labelPack과 같은 규율).
// ② **지금 뭐가 부족한지는 세어 봐야 안다.** 코퍼스를 훑어 비어 있는 칸을 계산해
//    주문서에 싣는다 — 10차에 "직설 0건"을, 12차에 "문자 섞기 0건"을 뒤늦게 발견한
//    것이 전부 세어 보지 않아서였다.
//
// ── 이 자료의 신분 ──────────────────────────────────────────────────
// 받은 것은 **학습 전용**이다(labeler: external:*). 채택선·교사 기준선으로는 못 쓴다 —
// 우리가 정의를 알려주고 받은 답이라 그것으로 채점하면 자기 채점이 된다.
// `--exclude-labeler external:` 로 통째로 뺄 수 있게 출처를 남긴다.

const OUT_DIR = 'training/labeling';
const OUT = `${OUT_DIR}/generation-prompt.md`;

/** 지금 학습셋에 무엇이 얼마나 있는가 — 주문서의 근거가 된다 */
function census(): { byLabel: Map<string, number>; byKind: Map<string, number>; total: number } {
  const byLabel = new Map<string, number>();
  const byKind = new Map<string, number>();
  let total = 0;
  for (const f of ['synth.v2.jsonl', 'founder.jsonl']) {
    const p = `training/data/${f}`;
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { labels: string[]; kind: string };
      total += 1;
      byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
      if (e.labels.length === 0) byLabel.set('(정상)', (byLabel.get('(정상)') ?? 0) + 1);
      for (const l of e.labels) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
    }
  }
  return { byLabel, byKind, total };
}

/**
 * **회피 형태를 실제로 세어 본다.**
 * 12차에 `텔LE그RAM`이 통째로 뚫린 원인이 "코퍼스에 그 형태가 0건"이었는데,
 * 그 사실을 사람이 눈으로 훑어서야 알았다. 세는 코드가 있으면 다음엔 주문서가 알려 준다.
 */
function evasionShapes(): Map<string, number> {
  const out = new Map<string, number>([
    ['공백·기호로 벌리기', 0],
    ['한글 안에 라틴 문자 끼우기', 0],
    ['자모·유사 글자 치환', 0],
  ]);
  const p = 'training/data/synth.v2.jsonl';
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const { text } = JSON.parse(line) as { text: string };
    const body = text.split('[본문]')[1] ?? '';
    if (/[가-힣]\s+[가-힣]\s+[가-힣]|[가-힣][·.\-_][가-힣]/.test(body)) {
      out.set('공백·기호로 벌리기', (out.get('공백·기호로 벌리기') ?? 0) + 1);
    }
    if (/[가-힣][A-Za-z]+[가-힣]/.test(body)) {
      out.set('한글 안에 라틴 문자 끼우기', (out.get('한글 안에 라틴 문자 끼우기') ?? 0) + 1);
    }
    if (/[ㄱ-ㅎㅏ-ㅣ]/.test(body)) {
      out.set('자모·유사 글자 치환', (out.get('자모·유사 글자 치환') ?? 0) + 1);
    }
  }
  return out;
}

function main() {
  const want = Number(process.argv[2] ?? 200);
  const { byLabel, byKind, total } = census();
  const shapes = evasionShapes();

  const labelTable = STUDENT_LABELS.map(
    (l) => `| \`${l}\` | ${RISK_CATEGORY_LABEL[l]} | ${byLabel.get(l) ?? 0}건 |`,
  ).join('\n');

  const kindTable = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `| ${k} | ${n}건 |`)
    .join('\n');

  const shapeTable = [...shapes.entries()]
    .map(([k, n]) => `| ${k} | **${n}건** |${n === 0 ? ' ← **완전히 비어 있음**' : ''}`)
    .join('\n');

  const doc = `# 검수 학습 자료 생성 주문서

이 문서를 **저장소를 모르는 새 AI 창**에 통째로 붙여넣으십시오.

생성일 기준 학습셋 ${total}건. 아래 "비어 있는 칸"을 채우는 것이 이 주문의 목적입니다.

---

## 무엇을 만드는 일인가

한국 투자 리서치 플랫폼의 **게시 전 자동 검수 분류기**를 학습시킬 자료가 필요합니다.
독립 리서처가 유료 분석 리포트를 올리면, 규제 위반 소지가 있는 표현을 기계가 1차로
걸러내고 사람이 최종 판단합니다. 그 기계를 가르칠 예시를 만들어 주십시오.

**위반 예시를 만드는 것이 목적의 절반이고, 나머지 절반은 "위반처럼 보이지만 정상인
문장"입니다.** 후자가 없으면 분류기가 성실하게 쓴 리포트를 막게 되고, 이 플랫폼에서는
그것이 위반을 놓치는 것보다 비쌉니다(리서처가 떠나면 돌아오지 않습니다).

---

## 판정 기준 — 아래 규정을 그대로 따르십시오

이 규정은 실제 운영 검수기가 쓰는 것과 **글자 하나까지 같습니다.** 여기 없는 기준을
스스로 만들어 적용하지 마십시오.

\`\`\`
${SYSTEM_PROMPT.trim()}
\`\`\`

---

## 지금 학습셋에 무엇이 있는가

### 유형별

| 라벨 | 뜻 | 현재 |
|---|---|---|
${labelTable}
| (정상) | 위반 없음 | ${byLabel.get('(정상)') ?? 0}건 |

### 종류별

| 종류 | 현재 |
|---|---|
${kindTable}

### 회피 형태 — **여기가 가장 비어 있습니다**

| 형태 | 현재 |
|---|---|
${shapeTable}

실제로 이 구멍 때문에 \`텔LE그RAM을 통해 게별쭥으로 상담\`이 검수를 그대로 통과했습니다.
공백 벌리기만 배운 모델은 문자 섞기를 못 봅니다.

---

## 주문 — ${want}건

### 배분

| 몫 | 비율 | 무엇 |
|---|---|---|
| **하드 네거티브** | **40%** | 위반처럼 보이지만 **정상**. 가장 귀합니다 |
| 회피 형태 위반 | 20% | 위 표에서 0건인 형태를 **집중적으로** |
| 다중 위반 | 15% | 한 리포트에 위반 2~3개 |
| 평범한 위반 | 15% | 유형별로 고르게 |
| 순수 정상 | 10% | 아무 신호 없는 평범한 분석 |

### 반드시 흔들어야 하는 변수

한 축만 바꾸고 나머지를 고정하면 모델이 **고정된 쪽을 맥락으로 착각합니다.**
실제로 그렇게 됐습니다 — 예측 카드를 한 종류로만 학습시켰더니, 카드가 다른 리포트에서
탐지율이 통째로 0%가 됐습니다.

1. **예측 카드** — 방향(상승/하락) · 목표(3~80%) · 기간(7~365일) · 신뢰도(2~10)를
   매번 다르게. 본문과 무관한 값이어도 됩니다(카드가 배경임을 가르치는 것이 목적)
2. **자산군** — 국내주식 / 미국주식 / 코인
3. **문체** — 격식체·구어체·반말 섞임·이모지·줄바꿈 없는 긴 문단·개조식
4. **길이** — 한 문장짜리부터 400자 이상까지
5. **위반의 위치** — 첫 줄 / 한가운데 / **맨 끝**(끝에 숨기는 것이 실제 수법입니다)
6. **직설 ↔ 완곡** — 같은 위반을 노골적으로도, 에둘러서도

### 하드 네거티브를 만드는 요령

이 몫이 이 주문에서 가장 어렵고 가장 중요합니다. 아래 종류를 고르게:

- **부정문** — 금지 표현을 **부정**하는 문장 ("원금이 보장되지 않습니다", "수익을
  보장할 수 없습니다"). 표준 면책 문구입니다. 절대 위반이 아닙니다
- **리스크를 길게 다루지만 결론은 카드와 같은 방향** — 성실한 리포트의 모양입니다
- **정상적인 한글+영문 혼용** — \`삼성SDI를\`, \`코스닥ETF는\`, \`AI반도체\`, \`카카오T\`.
  회피와 글자 모양이 비슷하지만 정상입니다. **이게 없으면 회피 탐지가 정상 종목명을 막습니다**
- **일반론으로서의 위험 언급** — "무조건 오르는 자산은 없습니다"
- **공개 정보 출처 명시** — "공시 자료에 따르면", "IR 자료 기준"

---

## 출력 형식

**JSONL** — 한 줄에 객체 하나, 설명·마크다운·코드펜스 없이 **줄만** 주십시오.

\`\`\`
{"title":"제목","summary":"요약","assetClass":"KR_EQUITY","assetName":"삼성전자","direction":"UP","magnitudePct":12,"horizonDays":90,"confidence":5,"content":"본문","labels":["PROFIT_GUARANTEE"],"kind":"paraphrase","note":"왜 이 라벨인지 한 줄"}
\`\`\`

| 필드 | 값 |
|---|---|
| \`assetClass\` | \`KR_EQUITY\` / \`US_EQUITY\` / \`CRYPTO\` |
| \`direction\` | \`UP\` / \`DOWN\` |
| \`magnitudePct\` \`horizonDays\` \`confidence\` | 숫자. **매번 다르게** |
| \`labels\` | 위 표의 라벨 배열. **정상이면 \`[]\`** |
| \`kind\` | \`literal\` \`paraphrase\` \`evasion\` \`hard_negative\` \`normal\` \`multi\` 중 하나 |
| \`note\` | 판정 근거 한 줄 (사람이 검수할 때 씁니다) |

### 라벨링 규칙

- **위반이 여럿이면 전부 적으십시오.** 빠뜨린 유형은 "아니다"로 학습됩니다
- **애매하면 만들지 마십시오.** 확신이 서는 것만. 틀린 라벨 한 건이 맞는 라벨 열 건을
  깎습니다
- \`CARD_MISMATCH\`는 본문 결론과 카드가 어긋날 때만. 리스크를 길게 다루는 것은 위반이 아닙니다

---

## 하지 말아야 할 것

- **실존 인물·기관·사건을 특정하지 마십시오.** 종목명은 실재해도 되지만, 특정 회사에
  대한 미공개 정보처럼 읽히는 구체적 서술은 만들지 마십시오
- **같은 문장을 조사만 바꿔 반복하지 마십시오.** 그건 데이터가 아니라 중복입니다
- **설명을 덧붙이지 마십시오.** JSONL 줄만 주십시오

---

## 받은 뒤 (창업자용 메모)

\`\`\`bash
npm run gen:ingest -- <받은파일.jsonl> --from <어느AI인지>
\`\`\`

들어올 때 자동으로 걸립니다: 형식·라벨 오탈자 · **채점지와의 중복**(60% 이상 유사하면
거절) · 파일 안 중복. 출처는 \`external:<이름>\`으로 남아 나중에 통째로 뺄 수 있습니다.

**이 자료는 학습 전용입니다.** 우리가 정의를 알려주고 받은 답이라 채택선·교사 기준선으로
쓸 수 없습니다 — 그러면 자기가 낸 답안을 자기가 채점하는 것이 됩니다.
`;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, doc, 'utf-8');
  console.log(`\n주문서: ${OUT}  (${doc.length}자, ${want}건 요청)\n`);
  console.log('현재 학습셋에서 완전히 비어 있는 칸:');
  for (const [k, n] of shapes) if (n === 0) console.log(`  · 회피 — ${k}`);
  for (const l of STUDENT_LABELS) {
    const n = byLabel.get(l) ?? 0;
    if (n < 25) console.log(`  · ${l} ${n}건 (얇음)`);
  }
  console.log('');
}

main();
