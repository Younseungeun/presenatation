import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyRules, type ScreeningInput } from '../src/domain/compliance';
import { normalizePhrase, validatePhrase } from '../src/domain/learnedPhrases';

// **사전-정상 간섭 거리 실측** (20차 "먼저 재야 할 것" ① · 21차 Y-6 검토 확정 설계).
//
// 질문: 운영자가 등록할 법한 표현이 사전에 쌓이면 정상 문장 오탐이 얼마나 생기는가.
//
// 표현 후보의 원천 (21차 판정: 고쳐서 — 합성 코퍼스 위반 문장에서 기계적으로 추출):
//   손코퍼스(86)에서 뽑으면 채점지로 사전을 만드는 셈이다(17차 금기 정면). 지어내면
//   실제 등록 분포와 다르다. 합성 학습셋 390건의 위반 문장에서 잦은 글자 n-gram 을
//   기계적으로 뽑는다 — 반려 사유에서 표현이 나오는 실제 경로의 근사다.
//
// 재는 값의 한계 (21차 gap 17형 함정, 검토 스스로 지적): 자모 거리 1은 위험한 회피
// (원금보장→원금보쟝)와 안전한 별개 낱말(원금보장→원금보전)에서 같은 값이다.
// 그래서 이 측정은 5층(근사)이 아니라 **1~3층(정확·간격·자모)의 오탐 기여**만 잰다 —
// 5층 자격은 등록 시 충돌 검사가 따로 정한다.
//
// 실행: npm run probe:interference

interface SynthRow {
  text: string;
  labels: string[];
}

function bodyOf(text: string): string {
  const i = text.indexOf('[본문]');
  return (i >= 0 ? text.slice(i + 4) : text).trim();
}

function input(text: string): ScreeningInput {
  return {
    title: '',
    summary: '',
    content: text,
    assetClass: 'KR_EQUITY',
    assetName: '',
    direction: 'UP',
  };
}

function main() {
  const synth: SynthRow[] = readFileSync(
    join(process.cwd(), 'training', 'data', 'synth.v2.jsonl'),
    'utf-8',
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SynthRow);
  const violationBodies = synth.filter((r) => r.labels.length > 0).map((r) => bodyOf(r.text));

  const controls: string[] = readFileSync(
    join(process.cwd(), 'training', 'holdout', 'control-hand.jsonl'),
    'utf-8',
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { text: string }).text);

  // 후보 추출 — 정규화본에서 4~8글자 n-gram 빈도 (한글만, 문서 빈도 ≥ 5)
  const docFreq = new Map<string, number>();
  for (const body of violationBodies) {
    const norm = body.replace(/[^가-힣]/g, ' ');
    const grams = new Set<string>();
    for (const chunk of norm.split(/\s+/).filter((c) => c.length >= 4)) {
      for (let len = 4; len <= Math.min(8, chunk.length); len++) {
        for (let i = 0; i + len <= chunk.length; i++) grams.add(chunk.slice(i, i + len));
      }
    }
    for (const g of grams) docFreq.set(g, (docFreq.get(g) ?? 0) + 1);
  }
  const ranked = [...docFreq.entries()]
    .filter(([, n]) => n >= 5)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  // 겹침 제거 — 긴 표현이 이미 뽑혔으면 그 부분열은 버린다 (같은 표현의 그림자)
  const candidates: { phrase: string; freq: number }[] = [];
  for (const [gram, freq] of ranked) {
    if (candidates.length >= 40) break;
    if (candidates.some((c) => c.phrase.includes(gram) || gram.includes(c.phrase))) continue;
    if (validatePhrase(gram).length > 0) continue;
    candidates.push({ phrase: gram, freq });
  }

  console.log(`후보 ${candidates.length}개 (위반 ${violationBodies.length}문장, 문서빈도 ≥ 5)`);

  // 후보 전부를 사전으로 등록한 상태에서 대조군 54를 통과시킨다 (1~3층만 — 5층 자격은
  // 등록 충돌 검사의 몫이라 phoneticEligible=false)
  const phrases = candidates.map((c, i) => ({
    id: `probe:${i}`,
    phrase: c.phrase,
    normalized: normalizePhrase(c.phrase),
    category: 'UNSUPPORTED_CLAIM' as const,
    note: null,
    phoneticEligible: false,
  }));

  const fpByPhrase = new Map<string, number>();
  let sentencesHit = 0;
  for (const text of controls) {
    const learned = applyRules(input(text), { phrases }).filter((f) => f.source === 'learned');
    if (learned.length > 0) sentencesHit += 1;
    for (const f of learned) {
      const p = phrases.find((x) => x.id === f.phraseId);
      if (p) fpByPhrase.set(p.phrase, (fpByPhrase.get(p.phrase) ?? 0) + 1);
    }
  }

  console.log(
    `대조군 ${controls.length}문장 중 오탐 문장 ${sentencesHit}건 (${((sentencesHit / controls.length) * 100).toFixed(1)}%)`,
  );
  const offenders = [...fpByPhrase.entries()].sort((a, b) => b[1] - a[1]);
  if (offenders.length === 0) {
    console.log('오탐을 만든 표현: 없음 — 위반 유래 표현과 정상 문장의 간섭 거리가 확보됨');
  } else {
    console.log('오탐을 만든 표현 (표현당 건수):');
    for (const [p, n] of offenders) console.log(`  "${p}" — ${n}건`);
  }
  const clean = candidates.length - offenders.length;
  console.log(`표현당 오탐 기여: 0건 ${clean}개 / 1건 이상 ${offenders.length}개`);
}

main();
