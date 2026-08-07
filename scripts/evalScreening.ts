import { applyRules, type Finding, RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { matchLearnedPhrases, type LearnedPhrase } from '../src/domain/learnedPhrases';
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
};

/** 문장 하나를 검수 입력으로 감싼다 — 코퍼스는 본문 문장 단위이므로 카드·종목 정보는 없다 */
function textDetector(phrases: LearnedPhrase[]): Detector {
  return (text: string): Finding[] => {
    const input = {
      title: '',
      summary: '',
      content: text,
      assetClass: 'KR_EQUITY' as const,
      assetName: '',
      direction: 'UP' as const,
    };
    return [...applyRules(input), ...matchLearnedPhrases(input, phrases)];
  };
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

  console.log('\n[문장 종류별]');
  for (const k of report.byKind) {
    const isViolation = ['literal', 'paraphrase', 'evasion'].includes(k.kind);
    const name = isViolation ? '탐지' : '오탐';
    console.log(
      `  ${(KIND_LABEL[k.kind] ?? k.kind).padEnd(28)} ${name} ${String(k.hit).padStart(2)}/${k.total}  ${pct(k.rate)}`,
    );
  }

  console.log('\n[위반 유형별 탐지율]');
  for (const c of [...report.byCategory].sort((a, b) => a.recall - b.recall)) {
    console.log(
      `  ${RISK_CATEGORY_LABEL[c.category].padEnd(22)} ${c.detected}/${c.total}  ${pct(c.recall)}`,
    );
  }

  if (report.falsePositives.length > 0) {
    console.log('\n[오탐 — 정상 문장인데 걸렸다]');
    for (const { item, findings } of report.falsePositives) {
      console.log(`  · "${item.text}"`);
      console.log(`      → ${findings.map((f) => RISK_CATEGORY_LABEL[f.category]).join(', ')}`);
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

  print('결정적 규칙만', evaluate(textDetector([]), SCREENING_CORPUS));
  if (phrases.length > 0) {
    print(`규칙 + 학습 표현 ${phrases.length}건`, evaluate(textDetector(phrases), SCREENING_CORPUS));
  } else {
    console.log('\n(학습 표현 사전이 비어 있어 규칙 단독 결과만 표시합니다)');
  }

  console.log(
    '\n주의: 이 코퍼스는 손으로 만든 부트스트랩입니다. 절대 수치가 아니라 변경 전후 비교에만 쓰세요.\n',
  );
  await prisma.$disconnect();
}

main();
