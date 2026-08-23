import { readFileSync } from 'node:fs';
import { prisma } from '../src/server/db';
import { applyRules, SCREENING_LAYERS, type ScreeningInput } from '../src/domain/compliance';

// **실제 금융 문장 대조군에서 오탐률을 잰다** — 출시 전 마지막 관문 (17차 U-5/U-7).
//   npm run eval:control [-- --file training/holdout/control-dart.jsonl]
//
// 채택선: 오탐률 **0.1% 이하** (3,000문장에서 3건 이하).
// 근거는 Rule of Three — 0건이 관측되면 참 오탐률의 95% 상한이 3/N 이다.

const CARD = {
  assetClass: 'KR_EQUITY',
  assetName: '삼성전자',
  direction: 'UP',
  targetType: 'RETURN_PCT',
  magnitudePct: 12,
  horizonDays: 90,
  confidence: 5,
} as const;

const TARGET_FP_RATE = 0.001;

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

async function main() {
  const file = arg('file') ?? 'training/holdout/control-dart.jsonl';
  let rows: { id: string; text: string }[];
  try {
    rows = readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as { id: string; text: string });
  } catch {
    console.log(`\n대조군 파일이 없습니다: ${file}\n  먼저: npm run corpus:dart -- --count 3000\n`);
    process.exitCode = 1;
    return;
  }

  const known = new Set(
    (await prisma.instrument.findMany({ select: { name: true, ticker: true } })).flatMap((r) => [
      r.name.toLowerCase(),
      r.ticker.toLowerCase(),
    ]),
  );

  const byLayer = new Map<string, { n: number; samples: string[] }>();
  let fp = 0;
  let blocked = 0;
  for (const row of rows) {
    const f = applyRules(
      { title: '', summary: '', content: row.text, ...CARD } as ScreeningInput,
      { knownNames: known },
    );
    if (f.length === 0) continue;
    fp += 1;
    if (f.some((x) => x.severity === 'BLOCK')) blocked += 1;
    for (const x of f) {
      const key = `${x.layer ?? '?'} · ${x.ruleId ?? x.category}`;
      const e = byLayer.get(key) ?? { n: 0, samples: [] };
      e.n += 1;
      if (e.samples.length < 3) e.samples.push(row.text.slice(0, 70));
      byLayer.set(key, e);
    }
  }

  const rate = fp / rows.length;
  console.log(`\n═══ 실제 금융 문장 대조군 ═══   ${file}\n`);
  console.log(`  문장 ${rows.length.toLocaleString()}건`);
  console.log(`  오탐 **${fp}건 (${(rate * 100).toFixed(3)}%)**   그중 즉시 거절 **${blocked}건**`);
  console.log(`  채택선 ${(TARGET_FP_RATE * 100).toFixed(1)}% → ${rate <= TARGET_FP_RATE ? '**통과**' : '**미달**'}`);
  // **표본이 작으면 0건이어도 0%를 말할 수 없다** (Rule of Three).
  // 이 줄이 없으면 54건짜리 대조군에서 "오탐 0%"라고 보고하게 된다 — 실제로 그랬다
  const need = Math.ceil(3 / TARGET_FP_RATE);
  if (rows.length < need) {
    console.log(
      `  ⚠ **표본이 부족합니다.** 0건이어도 참 오탐률의 95% 상한은 ` +
        `${((3 / rows.length) * 100).toFixed(2)}% 입니다 (3/N). ` +
        `0.1% 를 말하려면 ${need.toLocaleString()}건이 필요합니다.`,
    );
  }
  // **즉시 거절 오탐은 절대 조건이다** — 보류는 운영자가 되살리지만 거절은 못 되살린다
  if (blocked > 0) console.log('  ⚠ 즉시 거절 오탐이 있습니다. 이건 건수와 무관하게 고쳐야 합니다.');

  if (byLayer.size > 0) {
    console.log('\n[층·규칙별 오탐]');
    for (const [key, e] of [...byLayer.entries()].sort((a, b) => b[1].n - a[1].n)) {
      const layer = key.split(' · ')[0] as keyof typeof SCREENING_LAYERS;
      console.log(`  ${String(e.n).padStart(4)}건  ${key}${SCREENING_LAYERS[layer] ? ` (${SCREENING_LAYERS[layer]})` : ''}`);
      for (const s of e.samples) console.log(`          "${s}"`);
    }
  }
  console.log('');
}

main().then(() => process.exit(0));
