import { PrismaClient } from '@prisma/client';

/**
 * **개발 DB의 사람·거래 데이터를 비운다** — npm run reset:demo [-- --apply]
 *
 * 시드를 다시 깔기 전에 판을 치우는 도구다. 계정과 그에 딸린 것(리포트·카드·판정·구매·
 * 정산·검수 기록·신고·문의·승인)을 지우고, **계정과 무관한 자산은 남긴다.**
 *
 * ── 남기는 것과 그 이유 ────────────────────────────────────────
 * · `learnedPhrase` · `learnedPhraseHit` — 운영자가 반려하며 쌓은 사전. 사람이 만든 것이라
 *   시드로 복원되지 않는다
 * · `regressionCase` — 졸업이 남긴 **영구 시험지**. 이걸 지우면 다음 모델이 시험 없이
 *   채택된다("시험지가 비면 만점이 아니라 시험 불가"의 전제가 무너진다)
 * · `appSetting` — `student.promoted` 승격 기록이 여기 산다. 지우면 계기판이 대조할
 *   상대를 잃어 `promotionMatches` 가 영영 null 이 된다
 * · `instrument` · `instrumentQuote` — 종목 마스터 1.6만 건. 다시 받으려면 외부 호출이 필요하다
 * · `marketSnapshot` — 띠지 증감의 비교 기준. 과거 값은 다시 만들 수 없다(그 시점이 지났다)
 *
 * ── 지우는 순서를 정하지 않는다 ─────────────────────────────────
 * 외래키 순서를 손으로 적으면 표가 하나 늘 때마다 여기가 틀린다. 대신 **지워질 때까지
 * 여러 번 돈다** — 자식이 지워지면 다음 회차에 부모가 지워진다. 진전이 없으면 멈추고
 * 남은 표를 이름으로 알린다(그 표는 사람이 봐야 한다).
 */

const prisma = new PrismaClient();

const KEEP = new Set([
  'learnedPhrase',
  'learnedPhraseHit',
  'regressionCase',
  'appSetting',
  'instrument',
  'instrumentQuote',
  'marketSnapshot',
]);

const MAX_PASSES = 8;

type Table = { count(): Promise<number>; deleteMany(): Promise<{ count: number }> };

async function main() {
  const apply = process.argv.includes('--apply');
  const db = prisma as unknown as Record<string, Table>;
  const models = Object.keys(prisma).filter(
    (k) =>
      !k.startsWith('_') &&
      !k.startsWith('$') &&
      typeof (prisma as unknown as Record<string, { count?: unknown }>)[k]?.count === 'function',
  );

  const targets: string[] = [];
  const kept: string[] = [];
  for (const m of models) {
    const n = await db[m].count();
    if (n === 0) continue;
    if (KEEP.has(m)) kept.push(`${m} ${n}`);
    else targets.push(m);
  }

  console.log(`비울 표 ${targets.length}개: ${targets.join(', ')}`);
  console.log(`남길 표: ${kept.join(' · ') || '(없음)'}`);
  if (!apply) {
    console.log('\n미리보기입니다. 실제로 비우려면 `-- --apply` 를 붙이세요.');
    return;
  }

  let remaining = [...targets];
  for (let pass = 1; pass <= MAX_PASSES && remaining.length > 0; pass++) {
    const stuck: string[] = [];
    let deleted = 0;
    for (const m of remaining) {
      try {
        deleted += (await db[m].deleteMany()).count;
      } catch {
        // 외래키가 걸렸다 — 자식이 먼저 지워져야 한다. 다음 회차에 다시 시도한다
        stuck.push(m);
      }
    }
    console.log(`  ${pass}회차 — ${deleted}행 삭제, 남은 표 ${stuck.length}개`);
    if (stuck.length === remaining.length) {
      // **지우지 못한 표는 지우지 않고 이름을 알린다** — 억지로 밀면 무엇이 깨졌는지 모른다
      console.log(`  더 지울 수 없습니다: ${stuck.join(', ')}`);
      break;
    }
    remaining = stuck;
  }

  console.log('\n남은 행:');
  for (const m of models) {
    const n = await db[m].count();
    if (n > 0) console.log(`  ${m.padEnd(24)}${n}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
