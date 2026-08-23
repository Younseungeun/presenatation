import '@/server/db';
import { readFileSync } from 'node:fs';
import { applyRules, mergeFindings, RISK_CATEGORY_LABEL } from '../src/domain/compliance';
import type { RiskCategory, ScreeningInput } from '../src/domain/compliance';
import { createStudentClientFromEnv } from '../src/infra/compliance/studentClient';
import { STUDENT_LABELS } from '../src/domain/studentText';

// **선생(라벨)과 학생(모델)을 한 줄에 나란히 놓는다** (npm run compare:teacher).
//
//   npm run compare:teacher -- training/labeling/received-01.jsonl
//
// ⚠ **학습 전에 재야 뜻이 있다.** 학습한 뒤 같은 자료로 재면 외운 것을 채점하는 것이라
//   100%가 나와도 아무것도 증명하지 못한다. 일반화 여부는 손코퍼스(채점지)가 답한다.

interface Row {
  title?: string;
  summary?: string;
  assetClass?: string;
  assetName?: string;
  direction?: string;
  magnitudePct?: number;
  horizonDays?: number;
  confidence?: number;
  content?: string;
  labels?: string[];
  kind?: string;
}

const short = (c: RiskCategory) => RISK_CATEGORY_LABEL[c].replace(/·.*$/, '').slice(0, 8);

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.log('\n사용법: npm run compare:teacher -- <파일.jsonl>\n');
    process.exitCode = 1;
    return;
  }
  const client = createStudentClientFromEnv();
  if (!client || !(await client.usable())) {
    console.log('\n학생 모델을 쓸 수 없습니다 (사이드카·.env 확인)\n');
    process.exitCode = 1;
    return;
  }
  const health = await client.health();
  console.log(`\n═══ 선생 vs 학생 ═══   가중치 ${health?.modelSha}  임계값 ${process.env.STUDENT_THRESHOLD ?? '0.5'}\n`);

  const rows: Row[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('{')) rows.push(JSON.parse(t) as Row);
  }

  // 유형별 집계 — 선생이 붙인 라벨을 학생이 잡았는가
  const stat = new Map<string, { want: number; got: number }>();
  const bump = (k: string, hit: boolean) => {
    const s = stat.get(k) ?? { want: 0, got: 0 };
    s.want += 1;
    if (hit) s.got += 1;
    stat.set(k, s);
  };
  let normals = 0;
  let normalFalse = 0;
  const misses: { kind: string; want: string[]; got: string[]; text: string }[] = [];

  for (const r of rows) {
    if (!r.content) continue;
    const input: ScreeningInput = {
      title: r.title ?? '',
      summary: r.summary ?? '',
      content: r.content,
      assetClass: (r.assetClass as ScreeningInput['assetClass']) ?? 'KR_EQUITY',
      assetName: r.assetName ?? '',
      direction: r.direction === 'DOWN' ? 'DOWN' : 'UP',
      targetType: r.magnitudePct != null ? 'RETURN_PCT' : undefined,
      magnitudePct: r.magnitudePct ?? null,
      horizonDays: r.horizonDays ?? null,
      confidence: r.confidence ?? null,
    };
    // **운영에서 실제로 노출되는 것**을 잰다 — 규칙 ∪ 학생
    const out = await client.screen(input);
    const all = mergeFindings(applyRules(input), out?.findings ?? []);
    const got = [...new Set(all.map((f) => f.category))].filter((c) =>
      (STUDENT_LABELS as readonly string[]).includes(c),
    );
    const want = (r.labels ?? []).filter((l) => (STUDENT_LABELS as readonly string[]).includes(l));

    if (want.length === 0) {
      normals += 1;
      if (got.length > 0) {
        normalFalse += 1;
        misses.push({ kind: '오탐', want: [], got, text: r.content });
      }
      continue;
    }
    // 라벨 배열은 string, 소견은 RiskCategory — 집합으로 견준다
    const gotSet = new Set<string>(got);
    for (const w of want) bump(w, gotSet.has(w));
    const missed = want.filter((w) => !gotSet.has(w));
    if (missed.length > 0) misses.push({ kind: r.kind ?? '', want: missed, got, text: r.content });
  }

  console.log('  유형                     선생이 지적   학생+규칙이 잡음   탐지율');
  let tw = 0;
  let tg = 0;
  for (const l of STUDENT_LABELS) {
    const s = stat.get(l);
    if (!s) continue;
    tw += s.want;
    tg += s.got;
    const rate = (s.got / s.want) * 100;
    console.log(
      `  ${short(l as RiskCategory).padEnd(10)} ${l.padEnd(20)} ${String(s.want).padStart(3)}건  ` +
        `${String(s.got).padStart(8)}건  ${rate.toFixed(0).padStart(8)}%`,
    );
  }
  console.log(`  ${'합계'.padEnd(31)} ${String(tw).padStart(3)}건  ${String(tg).padStart(8)}건  ${((tg / tw) * 100).toFixed(0).padStart(8)}%`);
  console.log(`\n  정상 ${normals}건 중 잘못 잡음 **${normalFalse}건** (${((normalFalse / normals) * 100).toFixed(0)}%)`);

  const byKind = new Map<string, number>();
  for (const m of misses) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
  console.log('\n[놓친 것 — 종류별]');
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}건  ${k}`);
  }

  console.log('\n[놓친 예 — 앞 8건]');
  for (const m of misses.slice(0, 8)) {
    const w = m.want.length > 0 ? m.want.join(',') : '(정상인데 잡음)';
    console.log(`  · [${m.kind}] 선생 ${w} / 학생 ${m.got.join(',') || '없음'}`);
    console.log(`      "${m.text.slice(0, 62)}…"`);
  }
  console.log('');
}

main();
