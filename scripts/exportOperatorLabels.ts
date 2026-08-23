import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/server/db';
import { exportOperatorLabels } from '../src/server/operatorLabelExport';

// **운영자 판정 → 학습 자료**: npm run train:operator
//
//   npm run train:operator                    최근 5,000건 (오탐 + 미탐)
//   npm run train:operator -- --confirmed     정탐도 함께
//   npm run train:operator -- --clean         정상 통과 건도 함께
//   npm run train:operator -- --days 30       최근 30일만
//   npm run train:operator -- --dry-run       세기만 하고 쓰지 않는다
//
// 산출물: training/holdout/operator.jsonl  — **data/ 가 아니다** (29차 FF-4)
//
// ⚠ 14M 재학습에는 쓰지 않는다. r8 에서 14M 용량 포화가 증명됐으므로(비겨냥 11건 탈락),
//   50건을 교체해 넣어도 빠진 50건의 방어선이 무너지는 시소가 난다. 이 자료는 110M 부검
//   런의 **실전 검증셋**으로 전량 격리한다 — train.py 의 --data 에 넣지 말 것.
// ⚠ 다만 8차의 경고는 그대로다: 판정을 붙인 사람이 곧 모델을 채택할 사람이라, 이 자료의
//   수치는 **보고하되 게이트로 쓰지 않는다**(부사 스프레드와 같은 투명도 지표). 채택
//   게이트 6종은 이 자료를 모른다.

const OUT = 'training/holdout/operator.jsonl';

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

async function main() {
  const days = Number(arg('days') ?? '0');
  const result = await exportOperatorLabels(prisma, {
    includeConfirmed: process.argv.includes('--confirmed'),
    includeClean: process.argv.includes('--clean'),
    // 정탐 앵커 10% — 통째로 빼면 학생이 아는 위반을 잊는다 (17차 U-6)
    confirmedAnchorRatio: Number(arg('anchor') ?? '0.1'),
    since: days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined,
    limit: Number(arg('limit') ?? '5000'),
  });

  const c = result.counts;
  console.log(`\n운영자 판정에서 뽑은 학습 자료 **${c.total}건**`);
  console.log(`\n  ${String(c.operator_false_positive).padStart(5)}건  오탐 (하드 네거티브 — 가장 값지다)`);
  console.log(`  ${String(c.operator_missed).padStart(5)}건  미탐 (통과시켰다가 철회 — 이용자가 잡은 우회)`);
  console.log(`  ${String(c.operator_confirmed).padStart(5)}건  정탐 ${process.argv.includes('--confirmed') ? '(전부)' : '(앵커 표본 — --anchor 로 비율 조절, 0 이면 제외)'}`);
  console.log(`  ${String(c.operator_clean).padStart(5)}건  정상 통과 ${process.argv.includes('--clean') ? '' : '(--clean 으로 켠다)'}`);
  console.log(`\n  건너뜀 ${result.skipped}건 (경미·유형 미지목 미탐 — 라벨이 애매해 넣지 않는다)`);
  if (result.fatigued > 0) {
    console.log(`  ⚠ 피로 의심 판정 제외 **${result.fatigued}건** (열람→판정 3초 미만 — 안 읽고 누른 판정은 정답이 아니다)`);
  }
  if (result.leaked > 0) {
    console.log(`  ⚠ 채점지와 겹쳐 버림 **${result.leaked}건** — 코퍼스 문장이 운영에 흘러들었는지 확인하십시오`);
  }

  if (c.total === 0) {
    console.log('\n아직 판정이 없습니다. 출시 후 운영자가 승인·반려를 누르면 여기 쌓입니다.\n');
    return;
  }
  // **비율을 보고 사람이 판단한다** — 한쪽만 쌓이면 모델이 그쪽으로 기운다
  const violations = c.operator_missed + c.operator_confirmed;
  const normals = c.operator_false_positive + c.operator_clean;
  console.log(`\n  위반 ${violations}건 : 정상 ${normals}건`);
  if (violations === 0 || normals === 0) {
    console.log('  ⚠ **한쪽이 비어 있습니다.** 이대로 학습시키면 모델이 그 방향으로만 기웁니다.');
  }

  if (process.argv.includes('--dry-run')) {
    console.log('\n(--dry-run — 아무것도 쓰지 않았습니다)\n');
    return;
  }
  mkdirSync('training/holdout', { recursive: true });
  writeFileSync(OUT, result.examples.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  console.log(`\n→ ${OUT}`);
  console.log(`
재학습:
  cd training
  ../sidecar/.venv/Scripts/python.exe train.py \
      --data data/synth.v2.jsonl data/generated.jsonl data/operator.jsonl --epochs 12
  ../sidecar/.venv/Scripts/python.exe export_onnx.py
  cd .. && npm run eval:student -- --sweep      # 채택선을 통과하는지

⚠ **채택선을 통과하지 못하면 배포하지 마십시오.**
  특정 운영자의 판정이 의심되면: train.py --exclude-labeler operator:<userId>
`);
}

main().then(() => process.exit(0));
