import { canReleaseAutoShadow, forceReleaseAutoShadow, isAutoShadowed, releaseAutoShadow, resetAutoShadowCache } from '../src/server/studentAutoShadow';
import { createStudentClientFromEnv } from '../src/infra/compliance/studentClient';
import { prisma } from '../src/server/db';

// 학생 모델 자동 격하를 **사람이 푼다** (11차 검토 K-4).
//
//   npx tsx scripts/unlockStudent.ts
//   npx tsx scripts/unlockStudent.ts --force --reason "핫픽스 배포 후 창업자 직접 확인"
//
// ── 왜 CLI 에도 두는가 ──────────────────────────────────────────────
// 콘솔 버튼은 **증거가 맞을 때만** 풀린다(커버리지 스냅숏의 가중치 = 지금 서빙 중인
// 가중치). 그런데 사고 복구 중에는 운영자가 코드보다 현장을 잘 아는 순간이 있고,
// 그때 코드가 완전 통제하면 장애 응대가 마비된다.
//
// 그렇다고 콘솔에 "강제" 버튼을 두면 그것이 곧 일상 경로가 된다. **불편한 자리에
// 두는 것 자체가 문턱**이다 — 셸을 열고 사유를 적어야 한다.

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const force = process.argv.includes('--force');
  const reason = arg('reason');
  const actor = arg('actor') ?? 'cli';

  resetAutoShadowCache();
  if (!(await isAutoShadowed(prisma))) {
    console.log('\n격하가 걸려 있지 않습니다 — 할 일이 없습니다.\n');
    return;
  }

  const health = await createStudentClientFromEnv()?.health();
  const gate = await canReleaseAutoShadow(health?.modelSha);
  console.log(`\n서빙 중인 가중치  ${health?.modelSha ?? '(확인 불가 — 사이드카가 떠 있습니까?)'}`);
  console.log(`관문             ${gate.ok ? '✓' : '✗'} ${gate.reason}`);

  if (gate.ok) {
    await releaseAutoShadow(prisma, actor);
    console.log('\n✓ 해제했습니다. 학생 모델이 다음 검수부터 다시 참여합니다.\n');
    return;
  }

  if (!force) {
    console.log(
      '\n해제하지 않았습니다.\n' +
        '  정상 경로: 재학습 → export_onnx.py → npm run eval:student -- --write-snapshot\n' +
        '  그래도 지금 풀어야 한다면: --force --reason "사유"\n',
    );
    process.exitCode = 1;
    return;
  }

  if (!reason?.trim()) {
    console.log('\n✗ --force 에는 --reason "사유" 가 필요합니다.\n');
    process.exitCode = 1;
    return;
  }

  await forceReleaseAutoShadow(prisma, actor, reason);
  console.log(
    `\n⚠ **증거 없이 강제 해제했습니다.** 감사 로그에 남았습니다.\n` +
      `  사유: ${reason}\n` +
      '  지금 이 모델은 채택 판정을 통과한 적이 없습니다 — 되도록 빨리 재채택하십시오.\n',
  );
}

main().finally(() => prisma.$disconnect());
