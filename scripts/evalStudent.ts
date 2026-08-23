import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { REGRESSION_SEED_CORPUS, SCORING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import type { CorpusItem } from '../src/domain/__fixtures__/screeningCorpus';
import { applyRules, mergeFindings, RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import type { Finding } from '../src/domain/compliance';
import { writeFileSync } from 'node:fs';
import { corpusInput, evaluate, type Detector, type EvalReport } from '../src/domain/screeningEval';
import {
  COVERAGE_SNAPSHOT_PATH,
  RATCHET_KINDS,
  readCoverageSnapshot,
  ruleOnlyCoverage,
  type CoverageSnapshot,
} from '../src/domain/coverageMargin';
import { createStudentClientFromEnv } from '../src/infra/compliance/studentClient';

// 학생 모델 채택 판정: npm run eval:student [-- --sweep]
//
// **이 스크립트가 학생의 운명을 정한다.** train.py가 찍는 val macro-F1은 개발용 지표일
// 뿐이고, 채택은 이 저장소의 하네스 잣대로만 한다 — 규칙 기준선과 같은 코퍼스, 같은
// evaluate() 함수를 쓰므로 수치가 직접 비교된다.
//
// **채택선 (2026-08-19 개정 — 운영에 API를 쓰지 않기로 확정)**
//   ① 사람 손을 더 쓰게 만들지 않는다 — 오탐률 ≤ 규칙 기준선의 보류율
//   ② 비어 있는 자리를 메운다 — 패러프레이즈 탐지율 > 0% (규칙이 0%라 어떤 양수든 순이익)
// 옛 조건이던 "≤ 교사"는 뺐다. 운영에 교사가 없으면 비교할 상대가 없고, 없는 상대가
// 세운 문턱은 문턱이 아니다.
//
// **합산을 반드시 함께 본다.** 운영에서 학생 소견은 규칙 소견과 **합집합**으로 병합된다
// (mergeFindings). 학생 단독만 재면 "둘이 서로 다른 정상 문장을 잘못 잡아 합산이 두 배가
// 되는" 경우를 통과시킨다 — 3차 검토 E-α에서 찾은 결함이다.

/**
 * 비용비 λ — **오탐 1건이 미탐 1건의 몇 배로 나쁜가.**
 *
 * @근거 설계 — 이 프로젝트의 비용 모델("오탐 > 미탐")을 숫자로 옮긴 값이다.
 *   오탐은 리서처를 잘못 막는다: 게시가 늦어지고, 반복되면 떠난다. 떠난 공급자는
 *   되돌릴 수 없고 1단계 목표(리서처 30~50명 확보)를 직접 깎는다.
 *   미탐은 2차 방어선이 남아 있다 — 운영자 무작위 감사, 강제 철회(전액 환불·수수료 0),
 *   그리고 규칙·AI 검수가 같은 문장을 다시 본다.
 *   **4는 측정값이 아니라 정책값이고, 당분간 그대로 둔다** (9차 검토 G-5 확정).
 *   실측하려면 "보류를 겪은 리서처의 이탈률"을 알아야 하는데, 그것을 재려면 **리서처가
 *   실제로 떠나는 것을 방치해야 한다** — 1단계 목표가 리서처 30~50명 확보인 시점에
 *   그 실험의 비용이 얻을 정보보다 훨씬 크다. λ는 물리 상수가 아니라 **경영이 정하는
 *   위험 수용도**이므로, 정하는 것 자체가 정당하다.
 *   실측 시점: 거래액이 안정된 뒤 "오탐에 의한 게시 지연 → 이탈" 전환율을 코호트로
 *   재는 날. 그때까지는 고정하고, 대신 **여러 λ의 순이익을 나란히 찍어** 채택이 이 숫자
 *   하나에 걸려 있는지를 눈으로 보게 한다(선택은 최악의 λ에서 최대인 것으로 한다).
 */
const COST_RATIO = 4;

/** 판정에는 쓰지 않고 함께 보여주는 값들 — 결론이 λ에 얼마나 민감한지 드러낸다 */
const COST_RATIO_VIEW = [2, 4, 10];

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * 사이드카는 비동기이고 하네스의 Detector는 동기다. 먼저 전부 불러 캐시에 담고
 * 동기 함수로 되읽는다 — evalCoherence가 교사에 쓰는 것과 같은 방식이다.
 * 하네스를 비동기로 바꾸지 않는 이유: 탐지기 대다수(규칙)가 동기라 잣대가 무거워진다.
 */
async function prefetch(
  corpus: CorpusItem[],
  client: NonNullable<ReturnType<typeof createStudentClientFromEnv>>,
): Promise<{ cache: Map<string, Finding[]>; scored: CorpusItem[]; failed: number; latencies: number[] }> {
  const cache = new Map<string, Finding[]>();
  const scored: CorpusItem[] = [];
  const latencies: number[] = [];
  let failed = 0;
  for (const item of corpus) {
    if (item.probe) continue; // 정답이 없는 관측 항목은 채점하지 않는다
    const input = corpusInput(item);
    const out = await client.screen(input);
    if (!out) {
      // 장애를 "소견 없음"으로 넣으면 미탐으로 집계되어 학생이 실제보다 못해 보인다
      failed += 1;
      continue;
    }
    cache.set(input.content, out.findings);
    latencies.push(out.latencyMs);
    scored.push(item);
  }
  return { cache, scored, failed, latencies };
}

function cached(cache: Map<string, Finding[]>): Detector {
  return (input) => cache.get(input.content) ?? [];
}

/** 운영에서 실제로 노출되는 값 — 규칙과 학생의 합집합 */
function combined(cache: Map<string, Finding[]>): Detector {
  return (input) => mergeFindings(applyRules(input), cache.get(input.content) ?? []);
}

function line(label: string, r: EvalReport) {
  const kinds = ['paraphrase', 'literal', 'evasion', 'risk_heavy', 'negation', 'normal'] as const;
  const parts = kinds
    .map((k) => {
      const s = r.byKind.find((x) => x.kind === k);
      return s ? `${k} ${pct(s.rate)}` : null;
    })
    .filter(Boolean);
  console.log(
    `  ${label.padEnd(18)} 탐지 ${pct(r.recall).padStart(6)} · 오탐 ${pct(r.falsePositiveRate).padStart(6)}` +
      (parts.length ? `   [${parts.join(' · ')}]` : ''),
  );
}

async function run(threshold: number | null) {
  const client = createStudentClientFromEnv(
    threshold == null
      ? process.env
      : { ...process.env, STUDENT_THRESHOLD: String(threshold) },
  );
  if (!client) {
    console.log(
      '\nSTUDENT_SIDECAR_URL이 없습니다. 사이드카를 띄우고 다시 실행하세요:\n' +
        '  cd sidecar && .venv/Scripts/python -m uvicorn app:app --port 8765\n' +
        '  STUDENT_SIDECAR_URL=http://127.0.0.1:8765 npm run eval:student\n',
    );
    return null;
  }

  const health = await client.health();
  if (!health) {
    console.log('\n사이드카에 연결할 수 없습니다.\n');
    return null;
  }
  if (health.stub) {
    console.log(
      '\n⚠ 사이드카가 **스텁 모드**입니다 (가중치 없음) — 소견이 항상 0건이라\n' +
        '  탐지율 0%가 나옵니다. 이건 학생의 성적이 아니라 모델이 없다는 뜻입니다.\n' +
        '  training/export_onnx.py 로 model.int8.onnx 를 만든 뒤 사이드카를 재기동하세요.\n',
    );
  }
  // **낡은 가중치로 잰 숫자는 보고하지 않는다** (9차에 실제로 그렇게 보고했다).
  // 새 모델을 내보내고 사이드카를 다시 띄웠는데 옛 프로세스가 죽지 않으면, 이름도
  // 토크나이저도 그대로라 아무 신호 없이 옛 모델의 성적이 나온다.
  if (health.modelStale) {
    console.log(
      '\n⚠⚠ 사이드카가 **낡은 가중치**를 서빙 중입니다 — 적재 뒤 model.onnx 가 바뀌었습니다.\n' +
        '  옛 프로세스가 포트를 쥐고 있을 수 있습니다. 사이드카를 완전히 내리고 다시 띄우십시오.\n' +
        '  이 상태의 수치는 **의미가 없습니다.**\n',
    );
    return null;
  }
  console.log(`  가중치 ${health.modelSha ?? '(알 수 없음)'} · 토크나이저 ${health.tokenizerSha}`);

  if (health.trainedTokenizerSha && health.trainedTokenizerSha !== health.tokenizerSha) {
    console.log(
      `\n⚠⚠ 토크나이저 지문 불일치 — 학습 ${health.trainedTokenizerSha} ≠ 서빙 ${health.tokenizerSha}\n` +
        '  이 상태의 수치는 **의미가 없습니다.** 학습과 서빙이 다른 토크나이저를 씁니다.\n',
    );
    return null;
  }

  // 채점은 SCORING_CORPUS(69) — 회귀 시드 17건은 게이트가 따로 본다 (23차 Z-4)
  const sent = await prefetch(SCORING_CORPUS, client);
  const doc = await prefetch(COHERENCE_CORPUS, client);

  // **규칙 기준선을 같은 부분집합에서 다시 잰다.** 전체 코퍼스로 재면 사이드카 호출이
  // 실패한 건이 한쪽 분모에만 들어가 뺄셈이 성립하지 않는다 — 순이익은 두 값의 차이라
  // 분모가 어긋나면 없는 이득이 생기거나 있는 손해가 지워진다.
  const ruleOnly = evaluate((i) => applyRules(i), sent.scored);
  const ruleHold = ruleOnly.holdRate;
  const s = evaluate(cached(sent.cache), sent.scored);
  const sCombined = evaluate(combined(sent.cache), sent.scored);
  const d = evaluate(cached(doc.cache), doc.scored);
  const dCombined = evaluate(combined(doc.cache), doc.scored);

  // ── 순이익 (8차 E-2) ────────────────────────────────────────────────
  // 비율이 아니라 **건수**로 센다. "오탐률 ≤ 규칙 오탐률"은 합집합 병합에서 학생에게
  // 오탐 예산 0건을 강제하는데(합산은 언제나 규칙 이상이므로), 그건 3차가 세운 원칙
  // ("오탐이 미탐보다 나쁘다")이 아니라 그보다 훨씬 센 주장("오탐은 절대 불가")이다.
  const gainedHits = Math.round((sCombined.recall - ruleOnly.recall) * sCombined.violations);
  const addedFps = Math.round(
    (sCombined.falsePositiveRate - ruleOnly.falsePositiveRate) * sCombined.negatives,
  );
  const netValue = (lambda: number) => gainedHits - lambda * addedFps;

  const para = s.byKind.find((k) => k.kind === 'paraphrase')?.rate ?? 0;
  const riskHeavy = dCombined.byKind.find((k) => k.kind === 'risk_heavy')?.rate ?? 0;
  const lat = [...sent.latencies, ...doc.latencies].sort((a, b) => a - b);

  return {
    threshold: threshold ?? Number(process.env.STUDENT_THRESHOLD ?? '0.5'),
    reviewer: client.reviewerId,
    modelSha: health.modelSha,
    stub: health.stub,
    sent: s,
    sentCombined: sCombined,
    docCombinedKinds: dCombined.byKind,
    doc: d,
    docCombined: dCombined,
    ruleHold,
    ruleRecall: ruleOnly.recall,
    gainedHits,
    addedFps,
    netValue: netValue(COST_RATIO),
    netByLambda: COST_RATIO_VIEW.map((l) => ({ lambda: l, value: netValue(l) })),
    para,
    riskHeavy,
    failed: sent.failed + doc.failed,
    latencyP50: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
    // ① **순이익 > 0** (8차 E-2) — 새로 잡은 미탐이 새로 만든 오탐의 비용을 넘는가
    // ② **문서 오탐 0%** (8차에 뚫린 구멍) — 이 조건이 없던 동안 하네스가 "채택 가능"이라고
    //    말한 설정이 정상 문서 34건을 전부 걸고 있었다. 문장 오탐만 보면 문서 쪽 참사가
    //    판정에 들어오지 않는데, coherenceCorpus.ts는 risk_heavy 오탐을 "이 코퍼스의 유일한
    //    합격 조건에 가깝다"고 적어 두었다 — 문서에 있던 기준이 코드에 없었다.
    // ③ **즉시 거절 오탐 0건** — 절대 조건이다. 학생은 WARN만 내므로 구조적으로 0이지만,
    //    구조가 바뀌는 날 이 줄이 유일한 방어가 된다.
    pass:
      netValue(COST_RATIO) > 0 &&
      riskHeavy === 0 &&
      sCombined.blockingFalsePositives === 0,
  };
}

async function main() {
  const sweep = process.argv.includes('--sweep');
  // 스윕은 **단일 임계값**을 훑는다 (3차 F-1) — 128건으로 라벨별 8차원을 훑으면
  // 검증셋에 과적합된다. 미달이면 위험 성격 4단계로 묶는 것이 플랜 B다.
  //
  // **범위가 0.3에서 시작하면 안 된다** (8차 E-3 이후 실측). pos_weight 를 비용비에서
  // 유도하면(= 음성/양성 ÷ λ) 출력 분포가 통째로 아래로 밀린다 — 실제로 λ=4 학습에서
  // macro-AP 0.55 인 체크포인트의 F1@0.5 가 **0.0**이었다(0.5를 넘는 출력이 하나도 없다).
  // 저울이 눈금을 옮긴 것이지 분류력이 없는 것이 아니므로, 스윕이 그 자리를 덮어야 한다.
  // 좁은 범위만 훑으면 "채택 불가"라는 결론이 나오는데 그건 모델이 아니라 자의 문제다.
  const thresholds = sweep ? [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] : [null];

  console.log('\n═══ 학생 모델 채택 판정 ═══');
  // 명시적으로 타입을 준다 — worstCase 가 rows 의 원소 타입을 참조하는데,
  // 빈 배열에서 추론하면 any[] 가 되어 그 아래 계산이 전부 타입 검사를 빠져나간다.
  const rows: NonNullable<Awaited<ReturnType<typeof run>>>[] = [];
  for (const t of thresholds) {
    const r = await run(t);
    if (!r) return;
    rows.push(r);
    console.log(`\n▸ 임계값 ${r.threshold}  (${r.reviewer}${r.stub ? ', 스텁' : ''})`);
    line('문장 학생단독', r.sent);
    line('문장 규칙+학생', r.sentCombined);
    line('문서 학생단독', r.doc);
    line('문서 규칙+학생', r.docCombined);
    if (r.failed > 0) console.log(`  ※ 호출 실패 ${r.failed}건은 집계 제외 (미탐 아님)`);
  }

  console.log(`
═══ 채택선 (8차 E-2 — 순이익) ═══`);
  console.log(`  ① 순이익 = 새로 잡은 미탐 − ${COST_RATIO} × 새로 만든 오탐 > 0`);
  console.log(`  ② risk_heavy 오탐률 0% — 리스크를 성실히 다룬 정상 문서를 걸지 않는다`);
  console.log(`  ③ 즉시 거절 오탐 0건 (절대 조건)`);
  console.log(`  ※ 규칙 단독 기준선: 탐지 ${pct(rows[0].ruleRecall)} · 보류 ${pct(rows[0].ruleHold)}`);
  console.log('');
  for (const r of rows) {
    console.log(
      `  t=${String(r.threshold).padEnd(4)} 새로잡음 ${String(r.gainedHits).padStart(3)}건` +
        `  새오탐 ${String(r.addedFps).padStart(3)}건` +
        `  순이익 ${String(r.netValue).padStart(4)} ${r.netValue > 0 ? '✓' : '✗'}` +
        `  패러프레이즈 ${pct(r.para).padStart(6)}` +
        `  risk_heavy ${pct(r.riskHeavy).padStart(6)} ${r.riskHeavy === 0 ? '✓' : '✗'}` +
        `  지연 ${r.latencyP50.toFixed(1)}ms` +
        `   → ${r.pass ? '**채택 가능**' : '미달'}`,
    );
  }

  // 결론이 λ 하나에 걸려 있는지 보여준다 — λ는 아직 측정값이 아니라 선언이다
  console.log('\n[비용비 λ에 대한 민감도]  순이익 = 새로잡음 − λ × 새오탐');
  console.log(`  ${'임계값'.padEnd(9)}${COST_RATIO_VIEW.map((l) => `λ=${l}`.padStart(7)).join('')}`);
  for (const r of rows) {
    console.log(
      `  t=${String(r.threshold).padEnd(7)}` +
        r.netByLambda.map((n) => String(n.value).padStart(7)).join(''),
    );
  }

  // **가장 불리한 λ에서의 순이익으로 고른다** (최소최대).
  //
  // 패러프레이즈 최대로 고르면 새 오탐을 아무리 만들어도 탐지가 높은 쪽이 뽑힌다 —
  // 순이익 채택선을 세워 놓고 옛 기준으로 고르는 셈이다. 그렇다고 λ=4에서의 순이익만
  // 보면 **아직 재지 않은 숫자 하나에 설정이 걸린다**(COST_RATIO 주석: 4는 측정이
  // 아니라 선언이다). 최악의 λ에서 최대인 설정은 λ가 나중에 어디로 정해지든 후회가
  // 가장 작고, 실제로 그 규칙이 "새 오탐 0건"인 설정을 고른다.
  const worstCase = (r: (typeof rows)[number]) => Math.min(...r.netByLambda.map((n) => n.value));
  const best = rows
    .filter((r) => r.pass)
    .sort((a, b) => worstCase(b) - worstCase(a) || b.netValue - a.netValue || b.para - a.para)[0];
  console.log(
    best
      ? `\n▶ 최악의 λ에서도 순이익 최대: **임계값 ${best.threshold}** ` +
          `(λ=${COST_RATIO} 순이익 ${best.netValue} · 최악 ${worstCase(best)} · ` +
          `새로잡음 ${best.gainedHits} · 새오탐 ${best.addedFps} · 패러프레이즈 ${pct(best.para)})\n`
      : '\n▶ 채택 가능한 설정이 없습니다. 데이터를 늘리거나 플랜 B(위험 성격 4단계 임계값)로.\n',
  );

  // ── 시맨틱 핑 게이트 (22차 Y-1(b) — 채택 조건 ④) ─────────────────────
  // 라이브 진입 관문(usable)이 이 문장으로 뇌사를 가르므로, **핑을 못 잡는 모델은
  // 채택해도 라이브에 못 들어간다** — 여기서 미리 잡아야 "채택했는데 영구 장애"라는
  // 모순이 안 생긴다. 첫 핑 문장이 실제로 그 모순을 만들 뻔했다(부정형 위반이라
  // 채택선 통과 모델이 침묵 — 2026-08-21 실측 후 문장·게이트를 함께 확정).
  if (best) {
    const { SEMANTIC_PINGS, NORMAL_PING_CEILING } = await import(
      '../src/infra/compliance/studentClient'
    );
    // 원점수를 봐야 하므로 임계값을 바닥까지 낮춘 별도 클라이언트로 잰다 — 위반 핑의
    // 마진(≥0.85)과 정상 핑의 상한(≤0.30)은 채택 임계값과 무관한 자격 요건이다
    const pingProbe = createStudentClientFromEnv({
      ...process.env,
      STUDENT_THRESHOLD: '0.01',
    });
    // 8문항 전부 + 자격 재실측 (25차): 위반 핑은 0.85 이상, 정상 핑은 0.30 이하로
    // **여유 있게** 통과해야 한다 — 턱걸이 핑은 다음 경계 재조정 학습에서 오경보가 된다
    const pingProblems: string[] = [];
    for (const p of SEMANTIC_PINGS) {
      const out = await pingProbe?.screen(p.input).catch(() => null);
      if (!out) {
        pingProblems.push(`${p.label} ${p.kind} 문항 호출 실패`);
        continue;
      }
      const score = out.findings.find((f) => f.category === p.label)?.confidence ?? 0;
      if (p.kind === 'violation') {
        if (score < 0.85)
          pingProblems.push(
            score < best.threshold
              ? `${p.label} 위반 문항 침묵 (${score.toFixed(2)})`
              : `${p.label} 위반 문항 마진 부족 (${score.toFixed(2)} < 0.85) — 문장 교체 검토`,
          );
      } else {
        const loud = out.findings.find((f) => (f.confidence ?? 0) > NORMAL_PING_CEILING);
        if (loud)
          pingProblems.push(
            `${p.label} 정상 문항에 ${loud.category} ${(loud.confidence ?? 0).toFixed(2)} (> ${NORMAL_PING_CEILING}) — 발작 또는 문장 부적격`,
          );
      }
    }
    if (pingProblems.length === 0) {
      console.log(`✓ 시맨틱 핑 8문항 통과 — 라이브 관문(usable)과 채택이 같은 것을 본다\n`);
    } else {
      console.log(
        '\n✗ **시맨틱 핑 게이트 실패 — 이 설정은 채택해도 라이브에 못 들어갑니다** (usable 이 막음)\n' +
          pingProblems.map((s) => `  · ${s}`).join('\n') +
          '\n  침묵한 라벨은 그 유형을 학습셋에 보강하십시오 — 핑 문장 자체를 넣는 것은 금지입니다.\n',
      );
      process.exitCode = 1;
      return;
    }
  }

  // ── 회귀 게이트 (20차 X-5 · 21차 Y-5(b)) — 졸업 대비쌍 전 건 통과가 채택의 AND 조건 ──
  // 순이익이 아무리 좋아도 졸업시킨 표현을 잊은 모델은 배포되지 않는다 (치명적 망각 방어).
  // 문항이 0건이면 게이트는 조용히 통과한다 — 아직 아무것도 졸업하지 않은 상태가 정상이다.
  if (best) {
    const { prisma } = await import('../src/server/db');
    const { getRegressionCases } = await import('../src/server/phraseGraduationService');
    const { runRegressionGate } = await import('../src/domain/regressionGate');
    // 초기 회귀 시드 17건 (23차 Z-4) + 졸업 대비쌍 (DB) — 둘 다 전 건 통과가 조건이다
    const seedCases = REGRESSION_SEED_CORPUS.map((item, i) => ({
      id: `seed:${i}`,
      text: item.text,
      expectViolation: item.violation !== null,
      category: item.violation,
    }));
    const dbCases = await getRegressionCases(prisma).catch(() => []);
    const cases = [...seedCases, ...dbCases];
    if (cases.length > 0) {
      const gateClient = createStudentClientFromEnv({
        ...process.env,
        STUDENT_THRESHOLD: String(best.threshold),
      });
      const gate = await runRegressionGate(cases, async (input) => {
        const out = await gateClient?.screen(input);
        return out ? out.findings : null;
      });

      // ── 실패 이력 기록 (관리자 앱 4회차 §3) — 격리 판단의 근거 자료 ──
      // DB 문항(졸업 대비쌍)만 기록한다 — 시드 17건은 fixture 라 행이 없고 격리
      // 대상도 아니다. gateFailCount 는 **다른 모델 지문**으로 떨어질 때만 오른다:
      // 같은 모델을 두 번 돌린 것은 증거가 두 배가 아니다.
      const gateSha = (await gateClient?.health())?.modelSha ?? null;
      for (const f of gate.failures) {
        if (f.id.startsWith('seed:')) continue;
        const row = await prisma.regressionCase.findUnique({ where: { id: f.id } });
        if (!row) continue;
        await prisma.regressionCase.update({
          where: { id: f.id },
          data: {
            lastGateFailAt: new Date(),
            lastGateFailSha: gateSha,
            gateFailCount:
              row.lastGateFailSha === gateSha ? row.gateFailCount : row.gateFailCount + 1,
          },
        });
      }
      if (gate.pass) {
        console.log(`✓ 회귀 게이트 통과 — 졸업 대비쌍 ${gate.total}건 전 건 정답\n`);
      } else {
        console.log(
          `\n✗ **회귀 게이트 실패 — 이 모델은 배포하면 안 됩니다** ` +
            `(${gate.total}건 중 ${gate.failures.length}건 오답)\n` +
            '  졸업시킨 표현을 학생이 잊었습니다. 학습셋에 그 유형을 보강해 다시 학습하거나,\n' +
            '  문항 자체가 잘못 쓰였다면 격리(2인 승인)로 빼십시오 — 허용 오답률은 없습니다.\n',
        );
        for (const f of gate.failures.slice(0, 6)) {
          console.log(
            `  · ${f.expectViolation ? `기대 ${f.expected}` : '기대 소견 없음'} / ` +
              `실제 ${f.got.length ? f.got.join(',') : '소견 없음'} — "${f.text.slice(0, 40)}"`,
          );
        }
        process.exitCode = 1;
        return;
      }
    }
  }

  const miss = rows[0].sent.misses.filter((m) => m.kind === 'paraphrase');
  if (miss.length > 0 && !rows[0].stub) {
    console.log(`[놓친 패러프레이즈 ${miss.length}건 — 다음 학습이 메워야 할 몫]`);
    for (const m of miss.slice(0, 6)) {
      console.log(`  · [${RISK_CATEGORY_LABEL[m.violation!]}] "${m.text.slice(0, 50)}"`);
    }
  }
  console.log('주의: 손코퍼스는 부트스트랩입니다. 절대 수치가 아니라 변경 전후 비교에 쓰세요.\n');

  if (best) {
    const rebaseAt = process.argv.indexOf('--rebase-snapshot');
    const reasonAt = process.argv.indexOf('--reason');
    reportCoverage(
      best,
      process.argv.includes('--write-snapshot'),
      rebaseAt >= 0 ? (process.argv[reasonAt + 1] ?? '') : null,
    );
  }
}

/**
 * **역할 분담을 눈에 보이게 만들고, 후퇴를 막는다** (10차 검토 I-2).
 *
 * 10차에 드러난 것: 규칙과 학생의 분업은 설계가 아니라 **데이터 구성의 부작용**이다.
 * 학습 코퍼스에 직설(literal)이 0건이라 학생은 그걸 배운 적이 없고, 규칙이 100%를
 * 덮고 있어 합산에서는 아무 증상이 없다. **규칙을 좁히는 날 구멍이 생긴다.**
 *
 * 그 사실을 문서에 적어 두면 잊힌다. 그래서 숫자로 남기고, 시험이 그 숫자를 지킨다:
 *  · 여기서 유형별 `규칙 단독 / 학생 단독 / 합산`을 스냅숏에 적는다
 *  · `coverageMargin.test.ts`가 사이드카 없이 **규칙 단독**을 다시 재서 후퇴를 막는다
 *  · 합산이 후퇴하면 스냅숏 기록 자체를 거부한다 — 라쳇을 아래로 돌릴 수 없다
 */
function reportCoverage(
  best: NonNullable<Awaited<ReturnType<typeof run>>>,
  write: boolean,
  /** `--rebase-snapshot --reason "…"` 로 넘어온 사유. null 이면 재기준 아님 */
  rebaseReason: string | null,
): void {
  // **규칙 기준선은 전체 코퍼스에서 잰다** — 시험이 사이드카 없이 같은 값을 다시
  // 낼 수 있어야 하기 때문이다. 순이익 계산에 쓰는 `ruleOnly`(호출 성공분 부분집합)와
  // 목적이 다르다: 저쪽은 뺄셈의 분모를 맞추는 것이고, 이쪽은 재현 가능성이다.
  const rules = ruleOnlyCoverage();
  const rate = (list: { kind: string; rate: number }[], k: string) =>
    list.find((x) => x.kind === k)?.rate ?? 0;
  const byKind = Object.fromEntries(
    RATCHET_KINDS.map((k) => [
      k,
      {
        rules: rules[k] ?? 0,
        student: rate(best.sent.byKind, k),
        combined: rate([...best.sentCombined.byKind, ...best.docCombinedKinds], k),
      },
    ]),
  ) as CoverageSnapshot['byKind'];

  console.log('[유형별 역할 분담 — 규칙 단독 / 학생 단독 / 합산]');
  for (const k of RATCHET_KINDS) {
    const c = byKind[k];
    const solo = c.rules === 0 && c.student > 0 ? '  ← 학생만' : c.student === 0 && c.rules > 0 ? '  ← 규칙만 (좁히면 구멍)' : '';
    console.log(`  ${k.padEnd(16)} ${pct(c.rules).padStart(6)} / ${pct(c.student).padStart(6)} / ${pct(c.combined).padStart(6)}${solo}`);
  }

  const prev = readCoverageSnapshot();
  const regressed = prev
    ? RATCHET_KINDS.filter((k) => byKind[k].combined < prev.byKind[k].combined - 1e-9)
    : [];
  if (regressed.length > 0 && !rebaseReason) {
    console.log(
      `\n✗ **합산 커버리지가 후퇴했습니다**: ${regressed.join(', ')}\n` +
        '  스냅숏을 갱신하지 않습니다 — 라쳇은 위로만 돕니다.\n' +
        '  잣대 자체가 바뀌어 옛 숫자와 견줄 수 없다면:\n' +
        '    npm run eval:student -- --sweep --write-snapshot --rebase-snapshot --reason "왜 견줄 수 없는지"\n',
    );
    process.exitCode = 1;
    return;
  }
  if (rebaseReason !== null && !rebaseReason.trim()) {
    console.log('\n✗ --rebase-snapshot 에는 --reason "사유" 가 필요합니다.\n');
    process.exitCode = 1;
    return;
  }
  if (!write) {
    console.log('\n(스냅숏을 갱신하려면 -- --write-snapshot)\n');
    return;
  }
  const snapshot: CoverageSnapshot = {
    measuredAt: new Date().toISOString().slice(0, 10),
    modelSha: best.modelSha ?? 'unknown',
    threshold: best.threshold,
    byKind,
    // **재기준은 기록에 남는다.** 남기지 않으면 다음 사람이 라쳇의 숫자를 보고
    // "쭉 올라온 값"이라고 읽는데, 실제로는 중간에 한 번 끊긴 값이다.
    ...(rebaseReason ? { rebasedFrom: prev ?? undefined, rebaseReason: rebaseReason.trim() } : {}),
  };
  if (rebaseReason) {
    console.log(
      `\n⚠ **라쳇을 재기준했습니다** — 후퇴한 항목: ${regressed.join(', ') || '(없음)'}\n` +
        `  사유: ${rebaseReason.trim()}\n`,
    );
  }
  writeFileSync(COVERAGE_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  console.log(`\n스냅숏 기록: ${COVERAGE_SNAPSHOT_PATH}\n`);
}

main();
