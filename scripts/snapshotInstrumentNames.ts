import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/server/db';

// 종목 마스터 이름 스냅숏 — 전수 충돌 시험이 DB 없이 CI에서 돌게 한다.
// npm run snapshot:instruments
async function main() {
  const rows = await prisma.instrument.findMany({ select: { name: true } });
  const names = [...new Set(rows.map((r) => r.name).filter(Boolean))].sort();
  mkdirSync('training/holdout', { recursive: true });
  writeFileSync('training/holdout/instrument-names.json', JSON.stringify(names), 'utf-8');
  console.log(`종목명 ${names.length.toLocaleString()}건 → training/holdout/instrument-names.json`);
}
main().then(() => process.exit(0));
