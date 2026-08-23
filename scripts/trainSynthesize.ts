import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { corpusInput } from '../src/domain/screeningEval';
import { createClaudeScreenerFromEnv } from '../src/infra/compliance/claudeScreener';
import {
  buildStudentText,
  isStudentLabel,
  type StudentLabel,
  type TrainingExample,
} from '../src/domain/studentText';

// 학습셋 2차 원천 — 합성 확장 (ANTHROPIC_API_KEY 필요):
//   npm run train:synth -- --generate 20   유형별 후보 문장 생성 → candidates.jsonl
//   npm run train:synth -- --label         교사가 후보를 라벨링   → synth.v1.jsonl
//
// **생성과 라벨링을 나눈 이유 — 생성 의도는 라벨이 아니다.**
// "손실보전 패러프레이즈를 만들어라"로 생성한 문장이 실제로 위반이라는 보장이 없다
// (생성 모델이 빗나간 문장도 나온다). 라벨은 검수와 같은 경로(교사 검수기)로 다시 판정해
// 붙인다 — 그래야 학생이 배우는 것이 "생성 프롬프트"가 아니라 **교사의 판단**이 된다.
// 의도와 교사 판정이 어긋난 문장은 따로 보고한다: 거기가 사람이 봐야 할 목록이다.
//
// 문서 단위(본문·카드 세트) 합성은 v2로 미룬다 — 카드와 정합/모순이 통제된 장문 생성은
// 검증 없이는 라벨 오염 위험이 커서, 손코퍼스 42건 + 운영 데이터로 먼저 간다.

const GEN_MODEL = 'claude-sonnet-5'; // 생성은 판정이 아니다 — 다양성이 목적이라 저렴한 쪽
const CANDIDATES = 'training/data/candidates.jsonl';
const OUT = 'training/data/synth.v1.jsonl';

/** 문장 생성 대상 — CARD_MISMATCH는 문서 단위라 제외 */
const SENTENCE_LABELS = [
  'PROFIT_GUARANTEE',
  'PRIVATE_INFO',
  'RUMOR',
  'SOLICIT_CONTACT',
  'UNSUPPORTED_CLAIM',
  'RISK_INDUCEMENT',
  'SCREENING_EVASION',
] as const satisfies readonly StudentLabel[];

interface Candidate {
  id: string;
  text: string;
  /** 생성 의도 — 라벨이 아니라 교사 판정과의 대조용. null이면 하드 네거티브 의도 */
  intended: StudentLabel | null;
}

function seeds(category: StudentLabel): string[] {
  return SCREENING_CORPUS.filter(
    (i) => i.violation === category && (i.kind === 'paraphrase' || i.kind === 'literal'),
  )
    .slice(0, 4)
    .map((i) => i.text);
}

async function generate(perCategory: number) {
  const client = new Anthropic();
  const candidates: Candidate[] = [];
  let seq = 0;

  for (const category of SENTENCE_LABELS) {
    const label = RISK_CATEGORY_LABEL[category];
    // 위반 패러프레이즈와 하드 네거티브를 **같은 유형에서 짝으로** 뽑는다.
    // 무관한 정상 문장은 아무것도 가르치지 않는다 — 어휘가 겹치는 정상이 값어치다.
    const prompts: [StudentLabel | null, string][] = [
      [
        category,
        `한국 투자 리서치 플랫폼의 검수 모델 학습용 데이터를 만듭니다.\n` +
          `금지 유형: "${label}"\n예시:\n${seeds(category).map((s) => `- ${s}`).join('\n')}\n\n` +
          `이 유형에 해당하지만 금지 단어를 그대로 쓰지 않고 돌려 말하는 새로운 한국어 문장 ` +
          `${perCategory}개를 만드세요. 문체·화자·상황을 다양하게 하세요.`,
      ],
      [
        null,
        `한국 투자 리서치 플랫폼의 검수 모델 학습용 데이터를 만듭니다.\n` +
          `"${label}" 유형과 어휘가 겹치지만 **위반이 아닌** 정상 문장 ${perCategory}개를 만드세요.\n` +
          `부정문("~을 약속하지 않습니다"), 리스크 고지·면책 문구, 그 주제를 다루는 평범한 분석을 섞으세요.`,
      ],
    ];
    for (const [intended, prompt] of prompts) {
      const res = await client.messages.create({
        model: GEN_MODEL,
        max_tokens: 4_000,
        temperature: 1,
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: { sentences: { type: 'array', items: { type: 'string' } } },
              required: ['sentences'],
              additionalProperties: false,
            },
          },
        },
      } as unknown as Parameters<Anthropic['messages']['create']>[0]);
      const text = (res as Anthropic.Message).content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const parsed = JSON.parse(text) as { sentences?: string[] };
      for (const s of parsed.sentences ?? []) {
        candidates.push({ id: `synth:${seq++}`, text: s.trim(), intended });
      }
      console.log(`  ${label} ${intended ? '위반' : '정상'} 후보 ${parsed.sentences?.length ?? 0}건`);
    }
  }

  mkdirSync('training/data', { recursive: true });
  writeFileSync(CANDIDATES, candidates.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`\n${CANDIDATES} — ${candidates.length}건. 다음: npm run train:synth -- --label\n`);
}

async function label() {
  const screener = createClaudeScreenerFromEnv('teacher');
  if (!screener) throw new Error('ANTHROPIC_API_KEY가 없습니다');
  if (!existsSync(CANDIDATES)) throw new Error(`${CANDIDATES} 없음 — --generate 먼저`);

  const candidates: Candidate[] = readFileSync(CANDIDATES, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  console.log(`교사(${screener.reviewerId}) 라벨링 ${candidates.length}건 — 건당 API 1회…`);

  const out: TrainingExample[] = [];
  const disagreements: { c: Candidate; got: StudentLabel[] }[] = [];
  let failed = 0;
  for (const [i, c] of candidates.entries()) {
    // 문장 후보를 검수 입력으로 편다 — 하네스와 같은 중립 카드 (corpusInput 재사용)
    const input = corpusInput({ text: c.text, violation: null, kind: 'normal' });
    try {
      const { findings } = await screener.screen(input);
      const labels = [...new Set(findings.map((f) => f.category).filter(isStudentLabel))];
      out.push({
        id: c.id,
        source: 'synthetic',
        kind: c.intended ? 'paraphrase' : 'hard_negative',
        text: buildStudentText(input),
        labels,
        labeler: screener.reviewerId,
      });
      const agrees = c.intended ? labels.includes(c.intended) : labels.length === 0;
      if (!agrees) disagreements.push({ c, got: labels });
    } catch (e) {
      failed += 1; // 장애를 정상 라벨로 넣으면 안 된다 — 건너뛰고 센다
      console.log(`  ⚠ ${i + 1} 실패: ${(e as Error).message}`);
    }
    process.stdout.write(`\r  ${i + 1}/${candidates.length}`);
  }
  console.log('\n');

  writeFileSync(OUT, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`${OUT} — ${out.length}건 (실패 ${failed}건 제외)`);

  if (disagreements.length > 0) {
    console.log(
      `\n[의도 ↔ 교사 불일치 ${disagreements.length}건 — 학습 전에 사람이 볼 목록]\n` +
        '  라벨은 교사 판정을 따랐습니다. 의도대로 생성되지 않았거나 교사가 틀렸거나 둘 중\n' +
        '  하나인데, 어느 쪽인지는 사람만 압니다. 틀린 쪽이 교사라면 그 문장이 곧\n' +
        '  교사 오탐/미탐 사례이므로 평가 코퍼스에도 넣을 가치가 있습니다.',
    );
    for (const { c, got } of disagreements.slice(0, 20)) {
      const want = c.intended ? RISK_CATEGORY_LABEL[c.intended] : '정상';
      const g = got.length ? got.map((l) => RISK_CATEGORY_LABEL[l]).join(', ') : '정상';
      console.log(`  · "${c.text}"\n      의도 ${want} → 교사 ${g}`);
    }
    if (disagreements.length > 20) console.log(`  … 외 ${disagreements.length - 20}건`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--generate')) {
    const n = Number(args[args.indexOf('--generate') + 1]) || 20;
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY가 없습니다');
    await generate(n);
  } else if (args.includes('--label')) {
    await label();
  } else {
    console.log(
      '\n사용법:\n  npm run train:synth -- --generate 20   유형별 후보 생성 (위반 20 + 정상 20 × 7유형)\n' +
        '  npm run train:synth -- --label         교사 라벨링 → training/data/synth.v1.jsonl\n',
    );
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
