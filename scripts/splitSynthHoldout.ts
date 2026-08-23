import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// **합성 코퍼스에서 2차 채점지를 떼어낸다** (20차 X-4 · 검토 지시).
//
// 검토의 진단: 14M 모델에서 합성 491건은 수확 체감점 근처고, 더 늘리면 합성기의
// 패턴 자체를 외우는 과적합에 빠진다. 그런데 채점지가 손코퍼스 86문장뿐이라 그 과적합을
// **볼 눈이 없다.** 처방: 합성의 20%를 떼어 홀드아웃으로 **영구 편입**한다.
//
// ── 왜 무작위가 아니라 id 해시인가 ───────────────────────────────────
// 실행할 때마다 다른 20%가 떨어지면 ① 이미 학습에 쓰인 문장이 채점지로 넘어와
// 채점지가 오염되고 ② 재학습 간 성적을 견줄 수 없다. id 해시는 **같은 문장이 언제나
// 같은 쪽**에 떨어진다 — 정탐 앵커 표본(stableFraction)과 같은 이유, 같은 함수 모양.
//
// ⚠ 이미 491건 전부로 학습한 모델이 있다면 그 모델에게 이 홀드아웃은 **학습셋이다.**
// 분리는 다음 재학습부터 유효하다 — 지금 모델의 성적을 이 파일로 재면 안 된다.

const DATA = join(process.cwd(), 'training', 'data', 'synth.v2.jsonl');
const HOLDOUT = join(process.cwd(), 'training', 'holdout', 'synth-holdout.jsonl');

/** @근거 설계 — 20차 X-4 검토 확정값: 20% */
const HOLDOUT_FRACTION = 0.2;

/** id → 0~1 안정값 (operatorLabelExport.stableFraction 과 같은 FNV-1a) */
function stableFraction(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function main() {
  if (existsSync(HOLDOUT)) {
    // **한 번 가른 것은 다시 가르지 않는다.** 두 번 돌리면 남은 학습분에서 또 20%가
    // 떨어져 나가며 분리 기준이 흐려진다 — 홀드아웃은 영구라서 생성도 한 번이다
    console.log(`\n이미 분리되어 있습니다: ${HOLDOUT}`);
    console.log('다시 가르려면 두 파일을 손으로 되돌린 뒤 실행하십시오 (의도적 마찰).\n');
    return;
  }
  const lines = readFileSync(DATA, 'utf-8').split('\n').filter(Boolean);
  const train: string[] = [];
  const holdout: string[] = [];
  for (const line of lines) {
    const { id } = JSON.parse(line) as { id: string };
    (stableFraction(id) < HOLDOUT_FRACTION ? holdout : train).push(line);
  }
  writeFileSync(HOLDOUT, `${holdout.join('\n')}\n`, 'utf-8');
  writeFileSync(DATA, `${train.join('\n')}\n`, 'utf-8');
  console.log(`\n합성 ${lines.length}건 → 학습 ${train.length} / 홀드아웃 ${holdout.length}`);
  console.log(`  학습:     ${DATA}`);
  console.log(`  채점지:   ${HOLDOUT}  ← **영구. 어떤 경로로도 학습에 쓰지 말 것**\n`);
}

main();
