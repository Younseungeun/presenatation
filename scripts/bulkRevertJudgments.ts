import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { ASSET_CLASSES } from '../src/domain/constants';
import {
  BulkRevertRefused,
  executeBulkRevert,
  planBulkRevert,
  type BulkRevertFilter,
} from '../src/server/bulkRevertService';
import { getPauseState, setJudgmentPause } from '../src/server/judgmentPause';

// 회차 단위 롤백 — 시세 공급자가 며칠간 틀린 값을 준 것을 뒤늦게 알았을 때.
//
//   npm run judgment:pause  -- <ALL|KR_EQUITY|US_EQUITY|CRYPTO> <운영자 이메일> "사유"
//   npm run judgment:resume -- <ALL|KR_EQUITY|US_EQUITY|CRYPTO> <운영자 이메일> "사유"
//   npm run judgment:bulk-revert -- --from 2026-08-01 --to 2026-08-03 [--asset KR_EQUITY]
//                                   [--source fsc-data.go.kr]            ← 여기까지가 드라이런
//   npm run judgment:bulk-revert -- ... --execute <운영자 이메일> "사유" (--source|--logic)
//
// **왜 CLI인가 (2026-08-15 외부 검토 반영)**
//
// 검토가 "AppSetting 다이얼을 어드민에 노출하면 TOTP가 먼저여야 한다"고 했고 맞다.
// 같은 논리가 이 도구에도 걸린다 — **일괄 롤백은 그 자체가 파괴적 행위**이고,
// 화면에 붙이는 순간 세션 하나가 하루치 판정을 한 번에 날릴 수 있게 된다.
// 지금은 TOTP가 없으므로 **셸 접근을 요구하는 자리에 둔다**(judgment:revert와 같은 판단).
//
// 반대로 **정지(pause)는 보호적 행위**라 화면에 둬도 된다 — 남이 눌러도 손해가
// "판정이 늦어짐"이고, 사고 때 가장 빨리 눌러야 하는 것이기도 하다.

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function operatorByEmail(email: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { email } });
  if (!u) throw new Error(`운영자를 찾을 수 없습니다: ${email}`);
  if (u.role !== 'OPERATOR') throw new Error(`운영자가 아닙니다: ${email} (role=${u.role})`);
  return u.id;
}

function parseScope(raw: string | undefined): AssetClass | 'ALL' {
  if (raw === 'ALL') return 'ALL';
  if (raw && (ASSET_CLASSES as readonly string[]).includes(raw)) return raw as AssetClass;
  throw new Error(`범위는 ALL 또는 ${ASSET_CLASSES.join('|')} 중 하나여야 합니다`);
}

async function pauseCommand(paused: boolean) {
  const [scopeRaw, email, reason] = process.argv.slice(3).filter((a) => !a.startsWith('--'));
  if (!scopeRaw || !email || !reason) {
    console.error(
      `사용법: npm run judgment:${paused ? 'pause' : 'resume'} -- <ALL|${ASSET_CLASSES.join('|')}> <운영자 이메일> "사유"`,
    );
    console.error('\n사유는 필수입니다 — 왜 멈췄는지 모르면 언제 풀어야 하는지도 모릅니다.');
    process.exitCode = 1;
    return;
  }
  const scope = parseScope(scopeRaw);
  await setJudgmentPause(prisma, {
    scope,
    paused,
    operatorUserId: await operatorByEmail(email),
    reason,
  });
  console.log(`${scope} 자동 판정 ${paused ? '정지' : '해제'} — 사유: ${reason}`);
  console.log('현재 상태:', JSON.stringify(await getPauseState(prisma)));
  if (paused) {
    console.log('\n다음: npm run judgment:bulk-revert -- --from … --to … (먼저 드라이런)');
  }
}

async function bulkRevertCommand() {
  const from = arg('from');
  const to = arg('to');
  if (!from || !to) {
    console.error('사용법: npm run judgment:bulk-revert -- --from 2026-08-01 --to 2026-08-03 [--asset …] [--source …]');
    console.error('        (실행하려면) --execute <운영자 이메일> "사유" (--data-source | --logic)');
    console.error('\n판정 시각 구간은 **필수**입니다 — 없으면 "전부"가 되고, 그게 오타 한 번의 크기입니다.');
    process.exitCode = 1;
    return;
  }

  const filter: BulkRevertFilter = {
    judgedFrom: new Date(`${from}T00:00:00Z`),
    judgedTo: new Date(`${to}T23:59:59Z`),
    ...(arg('asset') ? { assetClass: arg('asset') as AssetClass } : {}),
    ...(arg('source') ? { dataSource: arg('source') } : {}),
  };

  const plan = await planBulkRevert(prisma, filter);
  console.log(`\n대상 ${plan.items.length}건 — 되돌릴 수 있음 ${plan.revertable} / 막힘 ${plan.blocked}`);
  console.log(`자동 판정 정지 상태: ${plan.paused ? '정지됨 ✓' : '**돌고 있음** ✗'}`);
  for (const i of plan.items) {
    const mark = i.blockedBy ? `✗ ${i.blockedBy}` : '되돌림';
    console.log(`  ${i.judgedAt.toISOString().slice(0, 10)} ${i.ticker.padEnd(10)} ${i.outcome.padEnd(12)} ${mark}`);
  }

  const executeIdx = process.argv.indexOf('--execute');
  if (executeIdx < 0) {
    console.log('\n드라이런입니다 — 아무것도 바뀌지 않았습니다.');
    console.log('실행하려면 --execute <운영자 이메일> "사유" (--data-source | --logic)를 붙이세요.');
    return;
  }

  const email = process.argv[executeIdx + 1];
  const reason = process.argv[executeIdx + 2];
  const dataSource = process.argv.includes('--data-source');
  const logic = process.argv.includes('--logic');
  if (!email || !reason || dataSource === logic) {
    console.error('\n--execute <운영자 이메일> "사유" (--data-source | --logic)');
    console.error('  --data-source  시세 소스 오류 → 되돌린 카드를 사람 판정 큐로 (같은 소스는 같은 답을 낸다)');
    console.error('  --logic        판정 로직 버그 → 자동 배치가 재판정 (코드를 먼저 고칠 것)');
    process.exitCode = 1;
    return;
  }

  const result = await executeBulkRevert(prisma, filter, {
    operatorUserId: await operatorByEmail(email),
    reason,
    cause: dataSource ? 'DATA_SOURCE' : 'PLATFORM_LOGIC',
  });

  console.log(`\n되돌림 ${result.reverted.length}건`);
  if (result.needsAccounting.length > 0) {
    console.log(`\n⚠ 회계 처리로 넘어가는 건 ${result.needsAccounting.length}건 — **돈이 이미 나갔습니다.**`);
    console.log('  장부만 되돌리면 DB는 깨끗한데 현실과 다른 상태가 됩니다.');
    for (const n of result.needsAccounting) console.log(`    ${n.ticker} ${n.judgmentId} — ${n.reason}`);
  }
  if (result.failed.length > 0) {
    console.log(`\n⚠ 실패 ${result.failed.length}건`);
    for (const f of result.failed) console.log(`    ${f.judgmentId} — ${f.reason}`);
  }
  console.log('\n다음: 시세가 정상인지 **직접 확인한 뒤** npm run judgment:resume 으로 여세요.');
  console.log('      (자동 해제는 없습니다 — 공급자가 고쳐졌는지 시스템은 알 수 없습니다)');
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'pause') return pauseCommand(true);
  if (cmd === 'resume') return pauseCommand(false);
  if (cmd === 'revert') return bulkRevertCommand();
  console.error('사용법: pause | resume | revert (package.json의 judgment:* 스크립트를 쓰세요)');
  process.exitCode = 1;
}

main()
  .catch((e) => {
    if (e instanceof BulkRevertRefused) {
      console.error(`\n거부: ${e.message}`);
      console.error('\n  npm run judgment:pause -- <범위> <운영자 이메일> "사유"');
      process.exitCode = 1;
      return;
    }
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
