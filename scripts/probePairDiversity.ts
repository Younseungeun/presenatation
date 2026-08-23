import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { charBigramJaccard } from '../src/domain/textSimilarity';

// **자카드 다양성 검사의 실효성 측정** (21차 "먼저 재야 할 것").
//
// 목적: 졸업 대비쌍(위반 3 + 정상 3)의 "복붙 감지" 컷오프를 근거 있게 정한다.
// 방법: 합성 학습 코퍼스(390건)에서 **같은 의도(같은 라벨)의 위반 문장 3개씩**을
// 무작위로 묶고, 각 그룹 안의 쌍별 자카드 유사도(글자 2-gram)를 잰다.
// "사람이 복붙하지 않고 자연스럽게 다르게 쓴 3문장"의 유사도 분포가 나오면,
// 그 분포의 위 꼬리가 곧 컷오프의 하한이다 — 자연스러운 3문장이 걸리면 안 되니까.
//
// 재는 값의 한계 (21차 검토 스스로 지적): 형태의 거리는 뜻의 다양성을 재지 못한다.
// "안 됩니다"/"불가능합니다"는 형태가 달라도 뜻이 같다. 이 컷오프가 막는 것은
// **복붙과 낱말 한둘 바꾼 변형**뿐이고, 의미가 한 점에 뭉친 3문장은 통과한다.
// 그 잔여 위험은 사람(운영자 지침)의 몫으로 남는다.
//
// 실행: npm run probe:diversity

interface Row {
  id: string;
  text: string;
  labels: string[];
}

function bodyOf(text: string): string {
  const i = text.indexOf('[본문]');
  return (i >= 0 ? text.slice(i + 4) : text).trim();
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

function main() {
  const raw = readFileSync(join(process.cwd(), 'training', 'data', 'synth.v2.jsonl'), 'utf-8');
  const rows: Row[] = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.labels.length > 0);

  const byLabel = new Map<string, string[]>();
  for (const r of rows) {
    const label = r.labels[0];
    const body = bodyOf(r.text);
    if (body.length < 10) continue;
    byLabel.set(label, [...(byLabel.get(label) ?? []), body]);
  }

  const rand = mulberry32(20260821);
  const sims: number[] = [];
  const groups = 2000;
  const labels = [...byLabel.entries()].filter(([, v]) => v.length >= 3);
  for (let g = 0; g < groups; g++) {
    const [, pool] = labels[Math.floor(rand() * labels.length)];
    const picked = new Set<number>();
    while (picked.size < 3) picked.add(Math.floor(rand() * pool.length));
    const [a, b, c] = [...picked].map((i) => pool[i]);
    sims.push(charBigramJaccard(a, b), charBigramJaccard(a, c), charBigramJaccard(b, c));
  }
  sims.sort((x, y) => x - y);

  // 대조: 복붙형 — 같은 문장에서 낱말 하나만 바꾼 쌍의 유사도 (컷오프가 잡아야 하는 것)
  const copyish: number[] = [];
  for (let g = 0; g < 500; g++) {
    const [, pool] = labels[Math.floor(rand() * labels.length)];
    const s = pool[Math.floor(rand() * pool.length)];
    const words = s.split(/\s+/);
    if (words.length < 3) continue;
    const w = [...words];
    w[Math.floor(rand() * w.length)] = '변경된낱말';
    copyish.push(charBigramJaccard(s, w.join(' ')));
  }
  copyish.sort((x, y) => x - y);

  console.log(`자연스러운 같은-의도 3문장 (쌍 ${sims.length}개, 라벨 ${labels.length}종):`);
  console.log(
    `  min ${sims[0].toFixed(3)} · p50 ${quantile(sims, 0.5).toFixed(3)} · p90 ${quantile(sims, 0.9).toFixed(3)} · p99 ${quantile(sims, 0.99).toFixed(3)} · max ${sims[sims.length - 1].toFixed(3)}`,
  );
  console.log(`낱말 하나 바꾼 복붙 쌍 (${copyish.length}개):`);
  console.log(
    `  min ${copyish[0].toFixed(3)} · p10 ${quantile(copyish, 0.1).toFixed(3)} · p50 ${quantile(copyish, 0.5).toFixed(3)}`,
  );
  const cut = 0.5;
  const naturalBlocked = sims.filter((s) => s > cut).length / sims.length;
  const copyPassed = copyish.filter((s) => s <= cut).length / Math.max(1, copyish.length);
  console.log(`검토 제안 컷오프 0.5 기준: 자연 쌍 오차단 ${(naturalBlocked * 100).toFixed(2)}% · 복붙 쌍 통과 ${(copyPassed * 100).toFixed(2)}%`);
}

main();

// ── 22차 "먼저 재야 할 것" ①: 길이 종속성 ─────────────────────────────
// 2-gram 자카드가 문장 길이에 종속되는지 — 길이 그룹별로 자연/복붙 분포를 다시 뽑는다.
function lengthProbe() {
  const raw = readFileSync(join(process.cwd(), 'training', 'data', 'synth.v2.jsonl'), 'utf-8');
  const rows: Row[] = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.labels.length > 0);
  const byLabel = new Map<string, string[]>();
  for (const r of rows) {
    const body = bodyOf(r.text);
    if (body.length < 10) continue;
    byLabel.set(r.labels[0], [...(byLabel.get(r.labels[0]) ?? []), body]);
  }
  const rand = mulberry32(20260822);

  for (const [name, filter] of [
    ['짧은 문장 (≤25자)', (s: string) => s.length <= 25],
    ['긴 문장 (≥40자)', (s: string) => s.length >= 40],
  ] as const) {
    const labels = [...byLabel.entries()]
      .map(([k, v]) => [k, v.filter(filter)] as const)
      .filter(([, v]) => v.length >= 3);
    if (labels.length === 0) {
      console.log(`\n[${name}] 표본 부족`);
      continue;
    }
    const nat: number[] = [];
    for (let g = 0; g < 2000; g++) {
      const [, pool] = labels[Math.floor(rand() * labels.length)];
      const picked = new Set<number>();
      while (picked.size < 3) picked.add(Math.floor(rand() * pool.length));
      const [a, b, c] = [...picked].map((i) => pool[i]);
      nat.push(charBigramJaccard(a, b), charBigramJaccard(a, c), charBigramJaccard(b, c));
    }
    nat.sort((x, y) => x - y);
    const copy: number[] = [];
    for (let g = 0; g < 500; g++) {
      const [, pool] = labels[Math.floor(rand() * labels.length)];
      const s = pool[Math.floor(rand() * pool.length)];
      const words = s.split(/\s+/);
      if (words.length < 3) continue;
      const w = [...words];
      w[Math.floor(rand() * w.length)] = '변경된낱말';
      copy.push(charBigramJaccard(s, w.join(' ')));
    }
    copy.sort((x, y) => x - y);
    const pool = labels.flatMap(([, v]) => v);
    console.log(`\n[${name}] 문장 ${pool.length}개 · 라벨 ${labels.length}종`);
    console.log(
      `  자연 쌍: p50 ${quantile(nat, 0.5).toFixed(3)} · p99 ${quantile(nat, 0.99).toFixed(3)} · max ${nat[nat.length - 1].toFixed(3)}`,
    );
    console.log(
      `  복붙 쌍: min ${copy[0]?.toFixed(3)} · p10 ${quantile(copy, 0.1).toFixed(3)} · p50 ${quantile(copy, 0.5).toFixed(3)}`,
    );
    console.log(
      `  컷 0.4 기준: 자연 오차단 ${((nat.filter((s) => s >= 0.4).length / nat.length) * 100).toFixed(2)}% · 복붙 통과 ${((copy.filter((s) => s < 0.4).length / Math.max(1, copy.length)) * 100).toFixed(2)}%`,
    );
  }
}

lengthProbe();
