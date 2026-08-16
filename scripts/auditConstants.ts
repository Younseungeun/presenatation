import { auditConstants, BASIS_KINDS, DEBT_FILE } from './lib/constantAudit';

// 남은 상수 빚을 세어 보여준다. `npm run debt:constants`
//
// `--list`를 주면 면제 목록에 그대로 넣을 수 있는 형태로 무태그 상수를 뽑는다
// (처음 목록을 만들 때만 쓴다 — 그 뒤로는 빚이 늘 일이 없어야 한다).

const root = process.cwd();
const r = auditConstants(root);
const listMode = process.argv.includes('--list');

if (listMode) {
  for (const s of [...r.untracked, ...r.remaining].sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(s.key);
  }
  process.exit(0);
}

const tagged = r.sites.length - r.untracked.length - r.remaining.length;
console.log(`숫자 상수 ${r.sites.length}개 — 근거 있음 ${tagged} / 빚 ${r.remaining.length}`);

const byKind = new Map<string, number>();
for (const s of r.sites) if (s.basis) byKind.set(s.basis.kind, (byKind.get(s.basis.kind) ?? 0) + 1);
const kinds = BASIS_KINDS.map((k) => `${k} ${byKind.get(k) ?? 0}`).join(' · ');
console.log(`  근거 종류: ${kinds}`);

if (r.untracked.length > 0) {
  console.log(`\n❌ 근거도 없고 ${DEBT_FILE}에도 없다 (${r.untracked.length}개)`);
  for (const s of r.untracked) console.log(`   ${s.file}:${s.line}  ${s.name}`);
}
if (r.malformed.length > 0) {
  console.log(`\n❌ 태그 형식이 틀렸다 (${r.malformed.length}개)`);
  for (const m of r.malformed) console.log(`   ${m.site.file}:${m.site.line}  ${m.site.name} — ${m.why}`);
}
if (r.paid.length > 0) {
  console.log(`\n✅ 갚았다 — ${DEBT_FILE}에서 지우세요 (${r.paid.length}개)`);
  for (const s of r.paid) console.log(`   ${s.key}`);
}
if (r.stale.length > 0) {
  console.log(`\n⚠ ${DEBT_FILE}에 있는데 그런 상수가 없다 (${r.stale.length}개)`);
  for (const k of r.stale) console.log(`   ${k}`);
}

if (r.remaining.length > 0) {
  console.log(`\n남은 빚 ${r.remaining.length}개 — 파일별`);
  const byFile = new Map<string, number>();
  for (const s of r.remaining) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
  for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`   ${n.toString().padStart(3)}  ${f}`);
}
