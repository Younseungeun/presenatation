import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// **r5 의 실전 약점 베이스라인** — r8 기각본 180문장 Zero-shot 추론 (29차 "먼저 재야 할 것").
//
// 이 180문장은 학습에 한 번도 들어가지 않았다(r8 기각 → rejected/ 격리). 라이브 확정본
// r5 가 여기서 보이는 점수 대역·미탐률이 런칭 직후 라이브 큐에서 만날 약점의 0점이고,
// 훗날 110M 으로 바꿀 때 같은 180문장의 점수 변화가 가장 깨끗한 체급 교체 지표가 된다.
// 추론 전용 — 어떤 가중치도 이 자료로 갱신하지 않는다 (FF-4: 14M 재학습 전면 취소).
//
//   STUDENT_SIDECAR_URL=... npx tsx scripts/probeZeroShotR8.ts
//   → training/baselines/zeroshot-r8-<modelSha>.json

const BASE = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765';
const SRC = 'training/rejected/generated.r8-round6.jsonl';
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

  // 위반 문장: 겨냥 라벨의 점수 분포와 임계값별 탐지율
  const targets = ['UNSUPPORTED_CLAIM', 'CARD_MISMATCH'];
  const violation: Record<string, unknown> = {};
  for (const label of targets) {
    const xs = scored.filter((s) => s.labels.includes(label)).map((s) => s.scores[label] ?? 0);
    violation[label] = {
      ...dist(xs),
      recall: Object.fromEntries(THRESHOLDS.map((t) => [t, xs.filter((x) => x >= t).length / xs.length])),
    };
  }
  // 정상 문장(뜻 짝 90): 어느 라벨이든 최대 점수 분포와 임계값별 오탐
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
  const file = `training/baselines/zeroshot-r8-${health.model_sha}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`model ${health.model_sha} · ${rows.length}문장 · src ${srcSha} → ${file}`);
  for (const label of targets) console.log(label, JSON.stringify(violation[label]));
  console.log('NORMAL(90) max-score', JSON.stringify({ ...normal, worst: undefined }));
  console.log('worst normals', JSON.stringify(normal.worst));
}
main().catch((e) => { console.error(e); process.exit(1); });
