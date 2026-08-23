import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { REGRESSION_SEED_CORPUS, SCORING_CORPUS } from '../src/domain/__fixtures__/screeningCorpus';
import { corpusInput } from '../src/domain/screeningEval';
import { buildStudentText } from '../src/domain/studentText';

// 26차 "먼저 재야 할 것" — 1차 분할 주입(100쌍) 전 시소 간섭 베이스라인.
//
// 라이브 학생의 채점지 69 + 회귀 시드 17 전건에 대한 **8라벨 원점수 전부**를 모델
// 지문별 JSON으로 박제한다. 다음 채택 판정 때 이 0점과 비교해 "겨냥하지 않은 라벨의
// 점수가 얼마나 내려앉았나"(시소)를 기계적으로 가린다 — CC-5 트립와이어의 눈금.
//
//   npx tsx scripts/captureSeesawBaseline.ts

const BASE = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765';

async function main() {
  const health = await (await fetch(`${BASE}/health`)).json() as {
    ready: boolean; model_sha: string;
  };
  if (!health.ready) throw new Error('사이드카가 준비되지 않았습니다');

  const items = [
    ...SCORING_CORPUS.map((item) => ({ item, set: 'scoring' as const })),
    ...REGRESSION_SEED_CORPUS.map((item) => ({ item, set: 'seed' as const })),
  ];
  const rows: object[] = [];
  for (const { item, set } of items) {
    const text = buildStudentText(corpusInput(item));
    const r = await fetch(`${BASE}/screen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, threshold: 0.01 }),
    });
    const j = (await r.json()) as { findings: { category: string; score: number }[] };
    rows.push({
      id: createHash('sha256').update(item.text).digest('hex').slice(0, 12),
      set,
      kind: item.kind,
      violation: item.violation,
      scores: Object.fromEntries(j.findings.map((f) => [f.category, Number(f.score.toFixed(4))])),
    });
  }
  mkdirSync('training/baselines', { recursive: true });
  const path = `training/baselines/seesaw-${health.model_sha}.json`;
  writeFileSync(path, JSON.stringify({
    capturedAt: new Date().toISOString(),
    modelSha: health.model_sha,
    purpose: '26차 시소 간섭 베이스라인 — 다음 채택 판정에서 비겨냥 라벨 하락 폭 비교의 0점',
    rows,
  }, null, 1));
  console.log(`저장: ${path} (${rows.length}건)`);

  // 요약 — 비겨냥 예정 과목(2차 몫: UNSUPPORTED·CARD_MISMATCH·RISK)의 현재 좌표
  for (const label of ['UNSUPPORTED_CLAIM', 'CARD_MISMATCH', 'RISK_INDUCEMENT']) {
    const hit = rows.filter((r: any) => r.violation === label);
    const line = hit.map((r: any) => r.scores[label]?.toFixed(2) ?? '?').join(' ');
    console.log(`${label} 위반 문항 ${hit.length}건 점수: ${line || '(채점지에 없음)'}`);
  }
  process.exit(0);
}
main();
