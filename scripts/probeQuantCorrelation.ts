import { readFileSync } from 'node:fs';
import { buildStudentText } from '../src/domain/studentText';

// **fp32 ↔ int8 점수 상관** (31차 HH-4 반증 조건): 새 정상 산문 1,000건에서 두 모델의 라벨 점수
// 피어슨 상관 < 0.95 면 게이트 통과는 우연이고 양자화가 지식을 파괴한 것이다.
//   A=http://127.0.0.1:8765 B=http://127.0.0.1:8766 npx tsx scripts/probeQuantCorrelation.ts
const A = process.env.A ?? 'http://127.0.0.1:8765';
const B = process.env.B ?? 'http://127.0.0.1:8766';
const N = Number(process.env.N ?? 1000);

async function scores(base: string, text: string): Promise<number[]> {
  const r = await fetch(`${base}/screen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, threshold: 0.0 }) });
  const j = (await r.json()) as { findings: { category: string; score: number }[]; labels?: string[] };
  const m = new Map(j.findings.map((f) => [f.category, f.score]));
  return LABELS.map((l) => m.get(l) ?? 0);
}
const LABELS = ['PROFIT_GUARANTEE', 'PRIVATE_INFO', 'RUMOR', 'SOLICIT_CONTACT', 'UNSUPPORTED_CLAIM', 'RISK_INDUCEMENT', 'SCREENING_EVASION', 'CARD_MISMATCH'];

async function main() {
  // 정제판이 아니라 원본 DART(control-dart.jsonl) 에서 정제판에 없는 문장을 쓴다 — 게이트 자료와 분리
  const clean = new Set(readFileSync('training/holdout/control-dart-clean.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text));
  const rows = readFileSync('training/holdout/control-dart.jsonl', 'utf8').split('\n').filter(Boolean)
    .map((l) => (JSON.parse(l) as { text: string }).text).filter((t) => !clean.has(t));
  const pool = rows.length >= N ? rows : [...rows, ...[...clean].slice(0, N - rows.length)];
  const xs: number[] = []; const ys: number[] = []; let maxAbs = 0; let flips = 0;
  for (const t of pool.slice(0, N)) {
    const text = buildStudentText({ title: '', summary: '', content: t, assetClass: 'KR_EQUITY', assetName: '', direction: 'UP' } as never);
    const [a, b] = await Promise.all([scores(A, text), scores(B, text)]);
    for (let i = 0; i < LABELS.length; i++) {
      xs.push(a[i]!); ys.push(b[i]!);
      maxAbs = Math.max(maxAbs, Math.abs(a[i]! - b[i]!));
      if ((a[i]! >= 0.7) !== (b[i]! >= 0.7)) flips += 1;
    }
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i]! - mx, dy = ys[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const r = sxy / Math.sqrt(sxx * syy);
  console.log(`문장 ${Math.min(N, pool.length)} (정제판 외 ${rows.length}) × 라벨 8 = ${xs.length} 점수쌍`);
  console.log(`피어슨 r = ${r.toFixed(4)}  (반증선 0.95)  · 최대 |Δ| ${maxAbs.toFixed(3)} · t0.7 판정 뒤집힘 ${flips}건`);
  process.exit(r >= 0.95 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
