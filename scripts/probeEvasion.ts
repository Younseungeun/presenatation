import '@/server/db';
import { readFileSync } from 'node:fs';
import { applyRules, mergeFindings, normalizeForRules } from '../src/domain/compliance';
import type { ScreeningInput } from '../src/domain/compliance';
import { prisma } from '../src/server/db';
import { createStudentClientFromEnv } from '../src/infra/compliance/studentClient';

// 13차 준비 — 우회 기법별로 **지금 무엇이 뚫리는지** 잰다 (일회성 탐침).
interface Case { g: string; t: string; w: string }

const CARD = {
  assetClass: 'KR_EQUITY' as const, assetName: '삼성전자', direction: 'UP' as const,
  targetType: 'RETURN_PCT' as const, magnitudePct: 12, horizonDays: 90, confidence: 5,
};

async function main() {
  const cases: Case[] = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
  const knownNames = new Set((await prisma.instrument.findMany({ select: { name: true, ticker: true } })).flatMap((r) => [r.name.toLowerCase(), r.ticker.toLowerCase()]));
  const client = createStudentClientFromEnv();
  const usable = client && (await client.usable());
  const th = Number(process.env.STUDENT_THRESHOLD ?? '0.5');
  console.log(`\n임계값 ${th}  학생 ${usable ? (await client!.health())?.modelSha : '없음'}`);
  // **이 코퍼스는 능력 지표가 아니다** (17차 U-2). 규칙을 이 문장들을 **보고** 만들었으므로
  // 성적은 자기가 낸 답안을 자기가 채점한 값이다. 회귀 방지용으로만 읽는다
  console.log(
    '\n⚠ 회귀 방지 지표입니다 — 규칙을 이 코퍼스를 보고 만들었으므로 능력 지표가 아닙니다.\n' +
      '  실제 오탐률은 npm run eval:control (DART 3,000문장)이 답합니다.\n',
  );

  const rows: { g: string; t: string; w: string; rule: string[]; stu: string[]; norm: string }[] = [];
  for (const c of cases) {
    const input: ScreeningInput = { title: '', summary: '', content: c.t, ...CARD };
    const rule = applyRules(input, { knownNames });
    const out = usable ? await client!.screen(input) : null;
    const all = mergeFindings(rule, out?.findings ?? []);
    rows.push({
      g: c.g, t: c.t, w: c.w,
      rule: [...new Set(rule.map((f) => f.category))],
      stu: [...new Set(all.map((f) => f.category))],
      norm: normalizeForRules(c.t).text,
    });
  }

  const groups = [...new Set(rows.map((r) => r.g))].sort();
  console.log('  기법                  건수   규칙만   규칙+학생');
  for (const g of groups) {
    const rs = rows.filter((r) => r.g === g);
    const isNormal = rs[0].w === '';
    const hitRule = rs.filter((r) => (isNormal ? r.rule.length > 0 : r.rule.includes(r.w as never))).length;
    const hitAll = rs.filter((r) => (isNormal ? r.stu.length > 0 : r.stu.includes(r.w as never))).length;
    const tag = isNormal ? '오탐' : '탐지';
    console.log(
      `  ${g.padEnd(20)} ${String(rs.length).padStart(3)}건  ` +
        `${`${hitRule}`.padStart(4)}(${((hitRule / rs.length) * 100).toFixed(0)}%)  ` +
        `${`${hitAll}`.padStart(6)}(${((hitAll / rs.length) * 100).toFixed(0)}%)  ${tag}`,
    );
  }

  console.log('\n[한 건씩]');
  for (const g of groups) {
    console.log(`\n── ${g}`);
    for (const r of rows.filter((x) => x.g === g)) {
      const isNormal = r.w === '';
      const ok = isNormal ? r.stu.length === 0 : r.stu.includes(r.w as never);
      const ruleOk = isNormal ? r.rule.length === 0 : r.rule.includes(r.w as never);
      console.log(
        `  ${ok ? '○' : '✗'} 규칙${ruleOk ? '○' : '✗'}  "${r.t.slice(0, 34)}"  →  ${r.stu.join(',') || '없음'}`,
      );
    }
  }
  console.log('');
}
main().then(() => process.exit(0));
