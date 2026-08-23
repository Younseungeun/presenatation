import {
  applyRules,
  type Finding,
  RISK_CATEGORY_LABEL,
  type ScreeningInput,
} from '../src/domain/compliance';
import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import type { LearnedPhrase } from '../src/domain/learnedPhrases';
import { evaluate, type Detector, type EvalReport } from '../src/domain/screeningEval';
import { prisma } from '../src/server/db';
import { getActiveLearnedPhrases } from '../src/server/learnedPhraseService';

// 검수 성능 기준선 측정: npm run eval:screening
//
// 이 수치가 앞으로 도입할 임베딩·분류기의 비교 대상이 된다. 모델을 붙였는데
// 여기 오탐률이 올라간다면 그 모델은 쓰면 안 된다 — 이 플랫폼에서 오탐은
// 놓친 위반보다 비싸기 때문(정상 리서처의 게시를 막아 공급을 잃는다).

const KIND_LABEL: Record<string, string> = {
  literal: '직설 (금지 표현 그대로)',
  paraphrase: '패러프레이즈 (같은 뜻, 다른 말)',
  evasion: '회피 (글자 벌리기·기호 삽입)',
  normal: '정상 분석 문장',
  negation: '부정문 (금지 표현을 부정)',
  disclosure: '리스크 고지·면책 문구',
  direction_flip: '방향 반대 (본문 ↔ 카드)',
  magnitude_gap: '크기 어긋남 (본문 ↔ 카드)',
  horizon_gap: '기간 어긋남 (본문 ↔ 카드)',
  flip_under_risk: '리스크로 위장한 방향 반대',
  coherent: '정합적인 리포트',
  risk_heavy: '리스크 서술 많음 (하드 네거티브)',
};

const TIER_LABEL: Record<string, string> = {
  REGULATORY: '규제 — 미탐이 플랫폼 법적 노출',
  CONSUMER: '소비자 — 미탐이 구매자 피해',
  INTEGRITY: '무결성 — 검수 자체를 겨냥',
  QUALITY: '품질 — 규제·피해 아님',
};

/** 위반 종류 — 이 목록은 screeningEval.VIOLATION_KINDS와 같아야 한다 */
const VIOLATION_KINDS = [
  'flip_under_risk',
  'literal',
  'paraphrase',
  'evasion',
  'direction_flip',
  'magnitude_gap',
  'horizon_gap',
];

/** 규칙 + 학습 표현. 카드를 보는 규칙도 함께 도므로 문서 코퍼스에도 그대로 쓴다 */
function ruleDetector(phrases: LearnedPhrase[]): Detector {
  // 사전은 규칙 엔진의 입력이다 (20차) — 운영과 같은 경로로 잰다
  return (input: ScreeningInput): Finding[] => applyRules(input, { phrases });
}

/** 문서 항목은 본문이 길다 — 목록에는 제목을 쓰고 없으면 앞부분만 자른다 */
function itemLabel(item: { text: string; title?: string }): string {
  if (item.title) return item.title;
  return item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function print(label: string, report: EvalReport) {
  console.log(`\n═══ ${label} ═══`);
  console.log(
    `표본 ${report.total}건 (위반 ${report.violations} / 정상 ${report.negatives})`,
  );
  console.log(`탐지율 ${pct(report.recall)} · 오탐률 ${pct(report.falsePositiveRate)}` +
    (report.wrongCategory > 0 ? ` · 유형 오인 ${report.wrongCategory}건` : ''));
  console.log(
    report.blockingFalsePositives === 0
      ? '즉시 거절 오탐 0건 ✓ (모든 오탐이 보류로만 이어져 운영자가 되살릴 수 있음)'
      : `⚠ 즉시 거절 오탐 ${report.blockingFalsePositives}건 — 정상 리포트가 사람 확인 없이 죽고 있습니다`,
  );

  console.log('\n[종류별]');
  for (const k of report.byKind) {
    const name = VIOLATION_KINDS.includes(k.kind) ? '탐지' : '오탐';
    console.log(
      `  ${(KIND_LABEL[k.kind] ?? k.kind).padEnd(28)} ${name} ${String(k.hit).padStart(2)}/${k.total}  ${pct(k.rate)}`,
    );
  }

  // 미탐의 **비용**이 다른 것끼리 먼저 본다. 총합 탐지율은 "규제 위반만 골라 새고 있는"
  // 상태를 가릴 수 있다 — 근거 없는 단정을 놓치는 것과 손실보전 약속을 놓치는 것이
  // 같은 1건으로 세지기 때문.
  console.log('\n[위험 성격별 — 미탐의 비용이 다르다]');
  for (const t of [...report.byTier].sort((a, b) => a.recall - b.recall)) {
    console.log(
      `  ${(TIER_LABEL[t.tier] ?? t.tier).padEnd(28)} ${t.detected}/${t.total}  ${pct(t.recall)}`,
    );
  }

  console.log('\n[위반 유형별 탐지율]');
  for (const c of [...report.byCategory].sort((a, b) => a.recall - b.recall)) {
    console.log(
      `  ${RISK_CATEGORY_LABEL[c.category].padEnd(22)} ${c.detected}/${c.total}  ${pct(c.recall)}`,
    );
  }

  console.log(
    `\n[운영자 부하] 정상 항목의 ${pct(report.holdRate)}가 보류로 이어집니다 — ` +
      '이 설계가 만들어내는 사람 손의 양입니다.\n' +
      '  ※ 문장 단위 값입니다. 한 문장만 걸려도 리포트 전체가 보류되므로\n' +
      '    문장이 여러 개인 실제 리포트의 보류율은 이 값보다 높습니다.',
  );

  if (report.falsePositives.length > 0) {
    console.log('\n[오탐 — 정상인데 걸렸다]');
    for (const { item, findings } of report.falsePositives) {
      console.log(`  · "${itemLabel(item)}"`);
      console.log(`      → ${findings.map((f) => RISK_CATEGORY_LABEL[f.category]).join(', ')}`);
    }
  }

  // 채점하지 않는다 — 정답이 없어서다. 탐지기가 뭐라고 하는지만 눈으로 본다.
  if (report.probes.length > 0) {
    console.log(
      `\n[경계 관측 ${report.probes.length}건 — 채점 제외]\n` +
        '  정답이 정해지지 않은 구간입니다. 라벨을 붙이면 그 임의의 판단이 곧 채택선이 되므로\n' +
        '  지금은 탐지기의 답만 기록합니다. 교사 실측·운영자 판정이 쌓이면 정식 라벨을 붙입니다.',
    );
    for (const { item, findings } of report.probes) {
      const said = findings.length
        ? findings.map((f) => RISK_CATEGORY_LABEL[f.category]).join(', ')
        : '소견 없음';
      console.log(`  · ${itemLabel(item)} → ${said}`);
    }
  }

  const paraphraseMisses = report.misses.filter((m) => m.kind === 'paraphrase');
  if (paraphraseMisses.length > 0) {
    console.log(`\n[놓친 패러프레이즈 ${paraphraseMisses.length}건 — 모델이 메워야 할 몫]`);
    for (const m of paraphraseMisses.slice(0, 8)) {
      console.log(`  · [${RISK_CATEGORY_LABEL[m.violation!]}] "${m.text}"`);
    }
    if (paraphraseMisses.length > 8) console.log(`  … 외 ${paraphraseMisses.length - 8}건`);
  }
}

async function main() {
  const phrases = await getActiveLearnedPhrases(prisma).catch(() => [] as LearnedPhrase[]);

  print('문장 단위 — 결정적 규칙만', evaluate(ruleDetector([]), SCREENING_CORPUS));
  if (phrases.length > 0) {
    print(
      `문장 단위 — 규칙 + 학습 표현 ${phrases.length}건`,
      evaluate(ruleDetector(phrases), SCREENING_CORPUS),
    );
  } else {
    console.log('\n(학습 표현 사전이 비어 있어 규칙 단독 결과만 표시합니다)');
  }

  // ── 문서 단위 ──
  //
  // 규칙의 성적을 여기서 재는 이유는 규칙이 잘하길 기대해서가 아니다. 정확히 반대로,
  // **0%라는 사실을 숫자로 박아두기 위해서**다. 이 값이 모델이 가져가야 할 몫 전부이고,
  // 나중에 이 자리가 0%가 아니게 됐다면 그건 규칙이 똑똑해진 게 아니라 넓어진 것이므로
  // 바로 아래 오탐률을 함께 봐야 한다.
  const coherence = evaluate(ruleDetector(phrases), COHERENCE_CORPUS);
  print('문서 단위 — 본문 ↔ 카드 정합성 (규칙 기준선)', coherence);

  if (coherence.recall === 0) {
    console.log(
      '\n※ 문서 단위 탐지율 0%는 결함이 아니라 **설계된 공백**입니다.\n' +
        '  본문과 카드를 맞대보는 규칙은 없고, 지금은 2차 Claude 검수만 이 판단을 합니다.\n' +
        '  **로드맵 1단계 어댑터로는 이 자리가 안 채워집니다** — 그 구조가 "문장 ↔ 고정된\n' +
        '  표현 사전"의 유사도라, 비교 대상이 매번 달라지는 카드가 들어갈 자리가 없습니다.\n' +
        '  기술의 한계가 아니라 그 어댑터의 목적이 다른 것입니다: 두 텍스트의 모순 판정은\n' +
        '  교차 인코더(NLI) 구조로 가능하며, 그러려면 카드를 문장으로 풀어 함께 넣어야 합니다.\n' +
        '  즉 선택지는 둘입니다 — NLI 교차 인코더를 따로 두거나, 증류 분류기(2단계)를 기다리거나.',
    );
  }
  if (coherence.falsePositiveRate > 0) {
    console.log(
      `\n⚠ 문서 단위 오탐 ${pct(coherence.falsePositiveRate)} — 위 목록을 확인하세요.\n` +
        '  risk_heavy(리스크를 길게 다루지만 결론은 카드와 일치)가 걸리기 시작하면\n' +
        '  성실하게 쓴 리서처일수록 더 막힙니다. 이 묶음의 오탐률이 모델 채택의 판정선입니다.',
    );
  }

  console.log(
    '\n주의: 두 코퍼스 모두 손으로 만든 부트스트랩입니다. 절대 수치가 아니라 변경 전후 비교에만 쓰세요.\n',
  );
  await prisma.$disconnect();
}

main();
