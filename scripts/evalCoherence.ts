import { COHERENCE_CORPUS } from '../src/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { applyRules, RISK_CATEGORY_LABEL, type Finding } from '../src/domain/compliance';
import { corpusInput, evaluate, type Detector } from '../src/domain/screeningEval';
import { createClaudeScreenerFromEnv } from '../src/infra/compliance/claudeScreener';

// 교사(2차 Claude 검수)의 문서 단위 성적: npm run eval:coherence
//
// **왜 규칙 기준선과 스크립트를 나눴는가**
// 규칙은 공짜라 매번 돌지만 이쪽은 문서 1건당 API 1회다. `eval:screening`에 넣으면
// 규칙 한 줄 고칠 때마다 돈이 나간다. 성격이 다른 측정이라 명령도 나눈다.
//
// **이 숫자가 무엇인가 — 증류의 천장이다.**
// 로드맵 2단계(증류 분류기)의 교사가 Opus 판정이므로, 교사가 못 잡는 것은 학생도
// 못 배운다. 교사 성적을 모른 채 증류하면 교사의 오차를 그대로 물려받고도 그 사실을
// 알 수 없다. 채택 기준을 여기서 문장으로 못 박아야 나중에 눈대중을 피한다:
//
//   > risk_heavy 오탐률이 교사를 넘지 않는 선에서, 세 가지 어긋남(방향·크기·기간)의
//   > 탐지율이 교사의 X% 이상인 증류 모델을 채택한다.
//
// **오탐률을 먼저 본다.** 탐지율이 교사와 같아도 risk_heavy를 더 잡는 학생은 쓸 수 없다 —
// 리스크를 충실히 쓴 정상 리포트를 막는 것이 이 플랫폼에서 가장 비싼 실수이기 때문.

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * 교사 단독 성적을 잰다 — 규칙과 병합하지 않는다 (섞으면 누가 잡았는지 사라진다).
 *
 * 하네스의 Detector는 동기 함수이고 API 호출은 비동기라, 먼저 전부 불러 두고
 * 결과를 되읽는 방식으로 맞춘다. 하네스를 비동기로 바꾸지 않는 이유는 규칙·임베딩처럼
 * 동기인 탐지기가 대다수이고, 그쪽에 비동기를 강요하면 잣대가 무거워지기 때문이다.
 */
function cachedDetector(cache: Map<string, Finding[]>): Detector {
  return (input) => cache.get(input.content) ?? [];
}

async function main() {
  const screener = createClaudeScreenerFromEnv('eval');
  if (!screener) {
    console.log(
      '\nANTHROPIC_API_KEY가 없어 교사 검수를 돌릴 수 없습니다.\n' +
        '규칙 기준선만 보려면 npm run eval:screening 을 쓰세요.\n',
    );
    return;
  }

  console.log(
    `\n교사(${screener.reviewerId}) 문서 ${COHERENCE_CORPUS.length}건 검수 중 — 건당 API 1회…\n`,
  );

  // 순차 호출: 동시에 쏘면 속도 제한에 걸리고, 34건이면 기다릴 만하다
  const cache = new Map<string, Finding[]>();
  let failed = 0;
  for (const [i, item] of COHERENCE_CORPUS.entries()) {
    const input = corpusInput(item);
    try {
      const out = await screener.screen(input);
      cache.set(input.content, out.findings);
    } catch (e) {
      // 장애는 "소견 없음"이 아니다 — 빈 배열로 넣으면 미탐으로 집계되어
      // 교사가 실제보다 못하는 것처럼 보인다. 세어서 따로 보고한다.
      failed += 1;
      console.log(`  ⚠ ${i + 1}/${COHERENCE_CORPUS.length} 실패: ${(e as Error).message}`);
    }
    process.stdout.write(`\r  ${i + 1}/${COHERENCE_CORPUS.length}`);
  }
  console.log('\n');

  const scored = COHERENCE_CORPUS.filter((item) => cache.has(corpusInput(item).content));
  const report = evaluate(cachedDetector(cache), scored);

  console.log('═══ 문서 단위 — 본문 ↔ 카드 정합성 (교사 기준선) ═══');
  console.log(`표본 ${report.total}건 (위반 ${report.violations} / 정상 ${report.negatives})`);
  if (failed > 0) console.log(`※ 검수 실패 ${failed}건은 집계에서 제외했습니다 (미탐이 아님)`);
  console.log(`탐지율 ${pct(report.recall)} · 오탐률 ${pct(report.falsePositiveRate)}`);

  console.log('\n[종류별]');
  const VIOLATION = ['direction_flip', 'magnitude_gap', 'horizon_gap'];
  for (const k of report.byKind) {
    console.log(
      `  ${k.kind.padEnd(16)} ${VIOLATION.includes(k.kind) ? '탐지' : '오탐'} ${k.hit}/${k.total}  ${pct(k.rate)}`,
    );
  }

  // ── 채택선 ──
  //
  // 초판은 "학생의 오탐률 ≤ 교사"라는 **상대 기준 하나뿐**이었다. 그 기준에는 바닥이
  // 없다 — 교사가 risk_heavy를 40% 오탐하면 채택선도 40%가 되어, 성실한 리포트 열 건 중
  // 넷을 막는 모델이 "합격"으로 나온다. 외부 검토가 이 구멍을 지적했고 맞는 지적이다.
  //
  // 그래서 절대 상한을 함께 둔다. 값은 임의로 고르지 않고 **문장 단위 기준선에서 파생**한다:
  // 새로 켜는 검수 층이 기존 층보다 사람 손을 더 쓰게 만들면 그 층은 순손실이다.
  // 기준선이 좋아지면 이 상한도 함께 조여진다.
  const sentenceBaseline = evaluate(
    (input) => applyRules(input),
    SCREENING_CORPUS,
  ).holdRate;
  const riskHeavy = report.byKind.find((k) => k.kind === 'risk_heavy');

  console.log(
    `\n▶ 채택선 — 두 조건을 **함께** 넘어야 합니다.\n` +
      `  ① 상대 — 학생의 risk_heavy 오탐률 ≤ 교사(${riskHeavy ? pct(riskHeavy.rate) : '측정 실패'})\n` +
      `  ② 절대 — risk_heavy 오탐률 ≤ ${pct(sentenceBaseline)} (현행 문장 단위 보류율에서 파생)\n` +
      '  탐지율이 아무리 높아도 이 둘을 못 넘으면 쓰지 않습니다 — 리스크를 충실히 쓴\n' +
      '  정상 리포트를 막는 것이 이 플랫폼에서 가장 비싼 실수이기 때문입니다.',
  );

  if (riskHeavy && riskHeavy.rate > sentenceBaseline) {
    console.log(
      `\n⚠ **교사 자체가 절대 상한을 넘었습니다** (${pct(riskHeavy.rate)} > ${pct(sentenceBaseline)}).\n` +
        '  이 경우 상대 기준은 무의미합니다 — 교사를 따라가면 기준 미달을 물려받습니다.\n' +
        '  증류로 넘어가기 전에 셋 중 하나를 먼저 해야 합니다:\n' +
        '   ⓐ 프롬프트 보강 — 오탐 사례를 CARD_MISMATCH 지침에 되먹임하고 다시 측정\n' +
        '   ⓑ 이 판단만 사람에게 유지 — 완결성은 자동 판정에서 빼고 운영자 큐로만 보낸다\n' +
        '   ⓒ 교사 교체 — 다른 모델로 같은 측정을 돌려 비교\n' +
        '  ⓑ가 기본값입니다. 판정 못 하는 것보다 잘못 판정하는 것이 비쌉니다.',
    );
  }

  if (report.falsePositives.length > 0) {
    console.log('\n[교사 오탐 — 정상 리포트인데 지적했다]');
    for (const { item, findings } of report.falsePositives) {
      console.log(`  · [${item.kind}] ${item.title ?? item.text.slice(0, 40)}`);
      console.log(`      → ${findings.map((f) => RISK_CATEGORY_LABEL[f.category]).join(', ')}`);
    }
  }

  if (report.misses.length > 0) {
    console.log('\n[교사가 놓친 어긋남 — 증류 모델도 여기는 못 배운다]');
    for (const m of report.misses) {
      console.log(`  · [${m.kind}] ${m.title ?? m.text.slice(0, 40)}`);
    }
  }

  console.log(
    '\n주의: 손으로 만든 부트스트랩입니다. 절대 수치가 아니라 변경 전후 비교에만 쓰세요.\n',
  );
}

main();
