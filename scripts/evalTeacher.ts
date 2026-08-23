import { existsSync, readFileSync } from 'node:fs';
import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { applyRules, RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import type { Finding } from '../src/domain/compliance';
import type { CorpusItem } from '../src/domain/__fixtures__/screeningCorpus';
import { corpusInput, evaluate, type Detector, type EvalReport } from '../src/domain/screeningEval';
import { createClaudeScreenerFromEnv } from '../src/infra/compliance/claudeScreener';
import {
  screeningCostUsd,
  TOKEN_PRICE_USD_PER_M,
  type ScreeningUsage,
} from '../src/infra/compliance/screener';
import type { StudentLabel, TrainingExample } from '../src/domain/studentText';

// 교사 기준선 — 두 경로가 있다:
//
//   npm run eval:teacher                    API 교사 (ANTHROPIC_API_KEY, 종량 과금)
//   npm run eval:teacher -- --from FILE     대화 교사 (구독으로 붙인 라벨, label:ingest 산출물)
//
// **왜 두 경로인가.** 라벨을 만드는 주체가 다를 뿐 재는 잣대는 같아야 한다. 두 경로 모두
// 같은 하네스(evaluate)를 쓰므로 수치가 직접 비교되고, 나중에 API로 갈아타도 이전 측정과
// 이어진다. 다만 **조건이 완전히 같지는 않다** — API 경로는 temperature 0 + 구조화 출력
// 강제이고 대화 경로는 그렇지 않다. 그래서 라벨에 labeler를 남겨 둘을 구분한다.
//
// **대화 라벨은 채택선·천장으로 인용할 수 없다 (2026-08-19 2차 검토 H-2 확정).**
// 대화 세션이 코퍼스 원본(정답 포함)을 접했는지 기계적으로 검증할 수 없어, 평가(기준선)는
// API 교사 또는 운영자 판정 위에서만 인정한다. 대화 라벨의 몫은 학습셋 생산이다.
// 이 규칙은 문서가 아니라 아래 코드가 강제한다 — 사람의 규율에 기대는 방어는 방어가 아니다.
//
// **이 숫자가 무엇인가 — 증류 천장이다.**
// 학생은 교사가 붙인 라벨로 배우므로 교사가 못 잡는 것은 학생도 못 배운다.
// 교사 성적을 모른 채 증류하면 교사의 오차를 그대로 물려받고도 그 사실을 알 수 없다.
//
// **채택선 — 절대 문턱을 미리 정하지 않는다. 제약 안에서 최대화한다:**
//   ① 상대 — 학생의 오탐률 ≤ 교사
//   ② 절대 — 학생의 오탐률 ≤ 규칙 기준선의 보류율
//      (새로 켜는 층이 기존 층보다 사람 손을 더 쓰게 만들면 그 층은 순손실이다)
//   그 제약을 지키는 설정 중 패러프레이즈 탐지율이 가장 높은 것을 고른다.

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

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
const VIOLATION_KINDS = [
  'literal', 'paraphrase', 'evasion',
  'direction_flip', 'magnitude_gap', 'horizon_gap', 'flip_under_risk',
];

/** 교사 단독 성적 — 규칙과 병합하지 않는다 (섞으면 누가 잡았는지 사라진다) */
function cachedDetector(cache: Map<string, Finding[]>): Detector {
  return (input) => cache.get(input.content) ?? [];
}

/** 라벨 → 소견. 유형만 쓴다 — AI 소견은 심각도와 무관하게 처리가 같고(보류) 하네스도 유형만 본다 */
function toFindings(labels: StudentLabel[]): Finding[] {
  return labels.map((category) => ({
    category,
    severity: 'WARN' as const,
    quote: '',
    reason: RISK_CATEGORY_LABEL[category],
    source: 'ai' as const,
  }));
}

function report(label: string, teacher: EvalReport, rules: EvalReport, holdBaseline: number) {
  console.log(`\n═══ ${label} ═══`);
  console.log(`표본 ${teacher.total}건 (위반 ${teacher.violations} / 정상 ${teacher.negatives})`);
  console.log(
    `탐지율 ${pct(teacher.recall)} · 오탐률 ${pct(teacher.falsePositiveRate)}` +
      (teacher.wrongCategory > 0 ? ` · 유형 오인 ${teacher.wrongCategory}건` : '') +
      `  (규칙 ${pct(rules.recall)} · ${pct(rules.falsePositiveRate)})`,
  );
  // 즉시 거절 오탐은 표시하지 않는다 — AI 소견에는 거절 권한 자체가 없어(REJECT는 규칙
  // BLOCK만) 구조적으로 0이다. 표시하면 "교사가 안전하다"는 잘못된 인상을 준다.

  console.log('\n[종류별 — 괄호 안은 규칙 기준선]');
  for (const k of teacher.byKind) {
    const name = VIOLATION_KINDS.includes(k.kind) ? '탐지' : '오탐';
    const rule = rules.byKind.find((r) => r.kind === k.kind);
    console.log(
      `  ${(KIND_LABEL[k.kind] ?? k.kind).padEnd(28)} ${name} ${String(k.hit).padStart(2)}/${k.total}  ${pct(k.rate)}` +
        (rule ? `  (규칙 ${pct(rule.rate)})` : ''),
    );
  }

  console.log('\n[위반 유형별 탐지율]');
  for (const c of [...teacher.byCategory].sort((a, b) => a.recall - b.recall)) {
    console.log(
      `  ${RISK_CATEGORY_LABEL[c.category].padEnd(22)} ${c.detected}/${c.total}  ${pct(c.recall)}`,
    );
  }

  // ── 채택선 (2026-08-19 개정 — 운영에 API를 쓰지 않기로 확정) ──
  //
  // 옛 채택선의 첫 조건은 "학생 오탐률 ≤ 교사"였는데, **운영에 교사가 없으면 비교할
  // 상대가 없다.** 없는 사람과 견주는 조건은 조건이 아니다. 학생이 이겨야 할 상대는
  // 지금 실제로 돌고 있는 것 — 규칙뿐이고, 규칙은 패러프레이즈를 0% 잡는다.
  // 그래서 기준이 뒤집힌다: **API를 이길 필요가 없고, 비어 있는 자리를 메우면 순이익이다.**
  const paraphrase = teacher.byKind.find((k) => k.kind === 'paraphrase');
  const riskHeavy = teacher.byKind.find((k) => k.kind === 'risk_heavy');
  console.log(
    `\n▶ 채택선 — 둘을 **함께** 지키는 설정 중 탐지율 최대를 고릅니다.\n` +
      `  ① 사람 손을 더 쓰게 만들지 않는다 — 학생 오탐률 ≤ ${pct(holdBaseline)} (규칙 기준선의 보류율)\n` +
      `  ② 비어 있는 자리를 메운다 — 패러프레이즈 탐지율 > 0% (규칙이 0%이므로 어떤 양수든 순이익)` +
      (riskHeavy
        ? `\n  ※ 문서 단위는 risk_heavy 오탐률이 판정선입니다 — 리스크를 충실히 쓴 정상\n    리포트를 막는 것이 이 플랫폼에서 가장 비싼 실수이기 때문입니다.`
        : ''),
  );
  console.log(
    `  참고 — 이 교사 표본의 성적: 오탐률 ${pct(teacher.falsePositiveRate)} · ` +
      `패러프레이즈 ${paraphrase ? pct(paraphrase.rate) : '—'}. **문턱이 아니라 참고선입니다**\n` +
      '  (교사는 운영에서 돌지 않으므로 학생이 이보다 낮아도 채택 가능합니다).',
  );

  if (teacher.falsePositives.length > 0) {
    console.log('\n[교사 오탐 — 정상인데 지적했다. 학생이 그대로 배울 목록이다]');
    for (const { item, findings } of teacher.falsePositives) {
      console.log(`  · [${item.kind}] "${item.title ?? item.text.slice(0, 60)}"`);
      console.log(`      → ${findings.map((f) => RISK_CATEGORY_LABEL[f.category]).join(', ')}`);
    }
  }
  if (teacher.misses.length > 0) {
    console.log('\n[교사가 놓친 위반 — 증류 모델도 여기는 못 배운다]');
    for (const m of teacher.misses) {
      console.log(
        `  · [${m.kind}] [${RISK_CATEGORY_LABEL[m.violation!]}] "${m.title ?? m.text.slice(0, 60)}"`,
      );
    }
  }
}

/** 규칙 기준선의 보류율 — 절대 상한의 근거. 항상 문장 코퍼스 전체에서 낸다 */
function holdBaseline(): number {
  return evaluate((input) => applyRules(input), SCREENING_CORPUS).holdRate;
}

function runFromFile(path: string) {
  if (!existsSync(path)) throw new Error(`${path} 없음 — npm run label:ingest 를 먼저 실행하세요`);
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TrainingExample);

  const labelers = [...new Set(rows.map((r) => r.labeler))];
  console.log(`\n라벨 ${rows.length}건 · 출처 ${labelers.join(', ')}`);

  // 오염 가능 라벨만 막는다. 저장소를 본 적 없는 새 창의 라벨(conversation-clean:)은
  // 코퍼스 파일을 읽을 방법 자체가 없으므로 기준선으로 인정한다 (2026-08-19 재확정 —
  // 2차 H-2의 "대화는 기준선 불가"는 과했다. 막을 것은 대화가 아니라 오염이었다).
  if (labelers.some((l) => l.startsWith('conversation:'))) {
    console.log(
      '\n⚠⚠ 오염 가능 세션의 라벨입니다 — **이 출력은 참고용이며 채택선으로 인용할 수 없습니다.**\n' +
        '   라벨링한 세션이 코퍼스 원본(정답이 함께 적혀 있다)을 읽었을 수 있어, 판정이\n' +
        '   독립적 판단이 아니라 정답 회상일 수 있습니다.\n' +
        '   → 저장소를 본 적 없는 새 창에서 팩을 라벨링하고\n' +
        '     npm run label:ingest -- --clean-session ... 로 병합하면 기준선이 됩니다.',
    );
  } else if (labelers.some((l) => l.startsWith('conversation-clean:'))) {
    console.log(
      '\n✓ 깨끗한 세션의 라벨입니다 — 채택선의 근거로 씁니다.\n' +
        '  단 재현성은 API(temperature 0)만큼 보장되지 않으므로, 이 값은 교사 판단의\n' +
        '  **한 표본**입니다. 학생을 여기에 견줄 때 소수점 차이를 유의미하게 읽지 마세요.',
    );
  }

  // id → 코퍼스 항목. 라벨 파일은 인덱스로만 코퍼스를 가리키므로 여기서 되짚는다
  const resolve = (id: string): CorpusItem | null => {
    const [prefix, n] = id.split(':');
    const idx = Number(n);
    if (prefix === 'sent') return SCREENING_CORPUS[idx] ?? null;
    if (prefix === 'doc') return COHERENCE_CORPUS[idx] ?? null;
    return null; // 합성 항목(synth:)은 코퍼스가 없어 성적 측정 대상이 아니다
  };

  for (const [prefix, corpus, label] of [
    ['sent', SCREENING_CORPUS, '문장 단위 — 교사 기준선 (대화 라벨)'],
    ['doc', COHERENCE_CORPUS, '문서 단위 — 본문 ↔ 카드 정합성 (대화 라벨)'],
  ] as const) {
    const mine = rows.filter((r) => r.id.startsWith(`${prefix}:`));
    if (mine.length === 0) continue;

    const cache = new Map<string, Finding[]>();
    const scored: CorpusItem[] = [];
    for (const row of mine) {
      const item = resolve(row.id);
      if (!item) continue;
      cache.set(corpusInput(item).content, toFindings(row.labels));
      scored.push(item);
    }
    const teacher = evaluate(cachedDetector(cache), scored);
    const rules = evaluate((input) => applyRules(input), scored);
    const covered = `${scored.length}/${corpus.filter((i) => !i.probe).length}`;
    report(`${label} — 라벨링 ${covered}`, teacher, rules, holdBaseline());
    if (scored.length < corpus.filter((i) => !i.probe).length) {
      console.log(
        `\n※ 아직 ${covered} 만 라벨링됐습니다. 남은 항목을 마저 라벨링하면 수치가 달라집니다 —\n` +
          '  부분 표본이라 절대 수치로 인용하지 마세요.',
      );
    }
  }
  console.log('\n주의: 손으로 만든 부트스트랩입니다. 절대 수치가 아니라 변경 전후 비교에만 쓰세요.\n');
}

/**
 * 마이크로 배치 (6차 검토 F-4 확정).
 *
 * 86건을 한 번에 돌리면 안 된다. 첫 측정이 곧 **동결된 천장**이 되는데, 그 측정이
 * 미검증 조건(캐싱 동작 여부·effort·프롬프트 버전) 위에서 이뤄지기 때문이다.
 * 10건으로 먼저 배관을 실측한다 — 비용 계산이 영수증과 맞는지, 캐시 읽기 토큰이
 * 실제로 찍히는지. 거기서 프롬프트·effort를 손보고, **동결한 뒤** 전량을 돌린다.
 *
 * 표본은 앞에서 자르지 않는다: 코퍼스가 유형별로 묶여 있어 앞 10건이 전부
 * PROFIT_GUARANTEE다. 균등 간격으로 뽑아야 배관 점검에 필요한 다양성이 나온다.
 */
function sample<T>(items: T[], limit: number): T[] {
  if (limit <= 0 || limit >= items.length) return items;
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, i) => items[Math.floor(i * step)]);
}

async function runFromApi(limit: number) {
  const screener = createClaudeScreenerFromEnv();
  if (!screener) {
    console.log(
      '\nANTHROPIC_API_KEY가 없어 API 교사를 돌릴 수 없습니다.\n' +
        '과금 없이 하려면 대화 교사 경로를 쓰세요:\n' +
        '  npm run label:pack        문제지 생성 → 대화에 붙여넣기\n' +
        '  npm run label:ingest -- training/labeling/answers-1.jsonl\n' +
        '  npm run eval:teacher -- --from training/data/teacher.v1.jsonl\n',
    );
    return;
  }
  const corpus = sample(SCREENING_CORPUS, limit);
  const micro = corpus.length < SCREENING_CORPUS.length;
  console.log(`\n교사(${screener.reviewerId}) 문장 ${corpus.length}건 검수 중…\n`);
  if (micro) {
    console.log(
      `⚠ 마이크로 배치 ${corpus.length}/${SCREENING_CORPUS.length}건 — **기준선이 아닙니다.**\n` +
        '  배관 점검용입니다: 비용 계산이 영수증과 맞는지, 캐시 읽기 토큰이 찍히는지.\n' +
        '  여기서 프롬프트·effort를 손본 뒤 동결하고, 그 다음 전량(--limit 0)을 돌립니다.\n',
    );
  }

  const cache = new Map<string, Finding[]>();
  const scored: CorpusItem[] = [];
  let failed = 0;
  const total: ScreeningUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  for (const [i, item] of corpus.entries()) {
    const input = corpusInput(item);
    try {
      const out = await screener.screen(input);
      cache.set(input.content, out.findings);
      scored.push(item);
      total.inputTokens += out.usage?.inputTokens ?? 0;
      total.outputTokens += out.usage?.outputTokens ?? 0;
      total.cacheWriteTokens! += out.usage?.cacheWriteTokens ?? 0;
      total.cacheReadTokens! += out.usage?.cacheReadTokens ?? 0;
    } catch (e) {
      // 장애는 "소견 없음"이 아니다 — 빈 배열로 넣으면 미탐으로 집계되어
      // 교사가 실제보다 못하는 것처럼 보인다. 세어서 따로 보고한다.
      failed += 1;
      console.log(`  ⚠ ${i + 1} 실패: ${(e as Error).message}`);
    }
    process.stdout.write(`\r  ${i + 1}/${corpus.length}`);
  }
  console.log('\n');

  const teacher = evaluate(cachedDetector(cache), scored);
  const rules = evaluate((input) => applyRules(input), scored);
  report(micro ? `문장 단위 — 마이크로 배치 ${corpus.length}건 (기준선 아님)` : '문장 단위 — 교사 기준선 (API)', teacher, rules, holdBaseline());
  if (failed > 0) console.log(`\n※ 검수 실패 ${failed}건은 집계에서 제외했습니다 (미탐이 아님)`);

  // 단가·계산은 screener.ts 한 곳에만 있다 (스크립트마다 적으면 단가 변경 시 갈라진다)
  const cost = screeningCostUsd(total);
  const n = Math.max(1, scored.length);
  console.log(
    `\n[비용] 입력 ${total.inputTokens.toLocaleString()} + 출력 ${total.outputTokens.toLocaleString()} 토큰` +
      ` ≈ $${cost.toFixed(2)} (건당 평균 $${(cost / n).toFixed(4)})`,
  );

  // 캐시 정산 — 이 수치가 캐싱을 유지할지 되돌릴지를 정한다 (screener.ts 주석 참고)
  const write = total.cacheWriteTokens ?? 0;
  const read = total.cacheReadTokens ?? 0;
  if (write + read > 0) {
    const hitRate = read / (write + read);
    // 캐시가 없었다면 read+write 토큰이 전부 정가로 나갔을 것이다
    const noCache = ((write + read) * TOKEN_PRICE_USD_PER_M.input) / 1_000_000;
    const withCache = ((write * 1.25 + read * 0.1) * TOKEN_PRICE_USD_PER_M.input) / 1_000_000;
    const delta = noCache - withCache;
    console.log(
      `[캐시] 히트율 ${(hitRate * 100).toFixed(1)}% (읽기 ${read.toLocaleString()} / 쓰기 ${write.toLocaleString()})` +
        ` — 손익분기 21.7%\n` +
        `       ${delta >= 0 ? '절감' : '손해'} $${Math.abs(delta).toFixed(4)}` +
        (hitRate < 0.217
          ? ' ⚠ 손익분기 미달 — 산발 호출에서도 계속 미달이면 캐싱을 되돌릴 것'
          : ' ✓'),
    );
    console.log(
      '       ※ 이 루프는 연속 호출이라 히트율이 높게 나옵니다. 운영 검수는 산발적이라\n' +
        '         다른 값이 나올 수 있고, 판정 근거는 운영 기록이지 이 수치가 아닙니다.',
    );
  }
  console.log('\n주의: 손으로 만든 부트스트랩입니다. 절대 수치가 아니라 변경 전후 비교에만 쓰세요.\n');
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--from');
  if (i >= 0) {
    runFromFile(args[i + 1] ?? 'training/data/teacher.v1.jsonl');
    return;
  }
  // 기본값 10 — 첫 실행이 실수로 전량을 돌려 천장을 미검증 조건에서 동결하는 것을 막는다.
  // 전량은 --limit 0 으로 명시해야 돈다 (6차 F-4)
  const l = args.indexOf('--limit');
  await runFromApi(l >= 0 ? Number(args[l + 1]) : 10);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
