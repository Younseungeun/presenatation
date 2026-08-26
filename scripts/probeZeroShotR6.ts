import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// **하드마진 일반화 Zero-shot** — r6 격리본 264건 (32차 II-5 반증 조건 · 후보 확정의 최종 도장).
//
// 이 264건은 r5·P0·P1 어느 학습에도 들어가지 않았다(r6 기각 → rejected/ 격리 —
// P2 런들만 학습했고 P2 는 후보가 아니다). 위반 134(PG 58·PRIVATE 38·SOLICIT 38) +
// 부정형 하드 네거티브 130 대비쌍이라, 여기서의 성적이 "P1-A 가 P1 자료를 통짜 암기한
// 것인지, 일반화를 배운 것인지"를 가른다:
//   - r5 대비 유의미한 탐지 향상 없음 → 암기 의심 (32차 II-5 반증 조건 실현)
//   - 부정형 130 에서 오탐 급증 → 부정 구분 없이 어휘만 외운 것 — 역시 반증
// 추론 전용 — 어떤 가중치도 이 자료로 갱신하지 않는다.
//
//   STUDENT_SIDECAR_URL=... npx tsx scripts/probeZeroShotR6.ts
//   → training/baselines/zeroshot-r6-<modelSha>.json

const BASE = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765';
const SRC = 'training/rejected/generated.r6-hardmargin.jsonl';
const THRESHOLDS = [0.3, 0.5, 0.7, 0.8];

interface Row { id: string; text: string; labels: string[] }

async function main() {
  const health = (await (await fetch(`${BASE}/health`)).json()) as { model_sha: string; ready: boolean };
  if (!health.ready) throw new Error('사이드카가 ready 가 아닙니다');
  const raw = readFileSync(SRC, 'utf8');
  const rows = raw.trim().split('\n').map((l) => JSON.parse(l) as Row);
  const srcSha = createHash('sha256').update(raw).digest('hex').slice(0, 12);

  const scored: { id: string; labels: string[]; scores: Record<string, number> }[] = [];
  for (const r of rows) {
    const res = (await (
      await fetch(`${BASE}/screen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: r.text, threshold: 0.01 }),
      })
    ).json()) as { findings: { category: string; score: number }[] };
    const scores: Record<string, number> = {};
    for (const f of res.findings) scores[f.category] = f.score;
    scored.push({ id: r.id, labels: r.labels, scores });
  }

  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
  };
  const dist = (xs: number[]) => ({
    n: xs.length, min: q(xs, 0), q1: q(xs, 0.25), median: q(xs, 0.5), q3: q(xs, 0.75), max: q(xs, 1),
  });

  // 위반: 겨냥 라벨 점수 분포 + 임계값별 탐지율
  const targets = ['PROFIT_GUARANTEE', 'PRIVATE_INFO', 'SOLICIT_CONTACT'];
  const violation: Record<string, unknown> = {};
  for (const label of targets) {
    const xs = scored.filter((s) => s.labels.includes(label)).map((s) => s.scores[label] ?? 0);
    violation[label] = {
      ...dist(xs),
      recall: Object.fromEntries(THRESHOLDS.map((t) => [t, xs.filter((x) => x >= t).length / xs.length])),
    };
  }
  // 부정형 하드 네거티브 130: 어느 라벨이든 최대 점수 분포 + 임계값별 오탐
  const normals = scored.filter((s) => s.labels.length === 0);
  const normalMax = normals.map((s) => Math.max(0, ...Object.values(s.scores)));
  const normal = {
    ...dist(normalMax),
    falsePositives: Object.fromEntries(
      THRESHOLDS.map((t) => [t, normalMax.filter((x) => x >= t).length]),
    ),
    worst: normals
      .map((s) => ({ id: s.id, label: Object.entries(s.scores).sort((a, b) => b[1] - a[1])[0] }))
      .sort((a, b) => (b.label?.[1] ?? 0) - (a.label?.[1] ?? 0))
      .slice(0, 5),
  };

  const out = {
    capturedAt: new Date().toISOString(), modelSha: health.model_sha, source: SRC, sourceSha: srcSha,
    n: rows.length, violation, normal, rows: scored,
  };
  mkdirSync('training/baselines', { recursive: true });
  const file = `training/baselines/zeroshot-r6-${health.model_sha}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`model ${health.model_sha} · ${rows.length}문장 · src ${srcSha} → ${file}`);
  for (const label of targets) console.log(label, JSON.stringify(violation[label]));
  console.log('HARD-NEG(130) max-score', JSON.stringify({ ...normal, worst: undefined }));
  console.log('worst negatives', JSON.stringify(normal.worst));
}
main().catch((e) => { console.error(e); process.exit(1); });
