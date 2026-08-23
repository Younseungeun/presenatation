import { readFileSync } from 'node:fs';

// **시소 간섭 판정** (26차 CC-5 확정 — 용량 트립와이어의 나머지 반쪽).
//
// captureSeesawBaseline 이 찍은 두 스냅샷(이전 채택 모델 vs 후보 모델)을 견줘,
// **겨냥하지 않은 라벨**의 문항이 통과→탈락으로 뒤집힌 수를 센다.
//
// 발동식 (검토자 확정 — 1회 관측으로 충분):
//   겨냥 라벨의 회귀 문항은 전건 통과하면서, 비겨냥 라벨 문항이 2건 이상 새로 떨어짐
//   → **시소 간섭. 즉시 110M 부검 런** (같은 데이터·같은 설정으로 KoELECTRA-base 학습,
//      게이트만 돌리고 채택하지 않는다):
//        base 통과  = 14M 용량 한계 입증 → 체급 교체 논의 개시
//        base 도 실패 = 데이터 품질(라벨 노이즈) 의심 → 신규 자료 재심
//
// 사용: npx tsx scripts/compareSeesaw.ts -- --before training/baselines/seesaw-<옛sha>.json \
//         --after training/baselines/seesaw-<새sha>.json --targets RUMOR,SOLICIT_CONTACT [--threshold 0.7]

interface Row {
  id: string;
  set: string;
  kind: string;
  violation: string | null;
  scores: Record<string, number>;
}

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

function main() {
  const before = JSON.parse(readFileSync(arg('before') ?? '', 'utf-8')) as { modelSha: string; rows: Row[] };
  const after = JSON.parse(readFileSync(arg('after') ?? '', 'utf-8')) as { modelSha: string; rows: Row[] };
  const targets = new Set((arg('targets') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const t = Number(arg('threshold') ?? '0.7');
  console.log(`이전 ${before.modelSha} → 이후 ${after.modelSha} (t=${t}, 겨냥: ${[...targets].join(',') || '없음'})\n`);

  const afterById = new Map(after.rows.map((r) => [r.id, r]));
  const flips: { row: Row; from: number; to: number }[] = [];
  let targetNewFails = 0;
  for (const b of before.rows) {
    if (b.violation === null) continue;
    const a = afterById.get(b.id);
    if (!a) continue;
    const from = b.scores[b.violation] ?? 0;
    const to = a.scores[b.violation] ?? 0;
    if (from >= t && to < t) {
      if (targets.has(b.violation)) targetNewFails += 1;
      else flips.push({ row: b, from, to });
    }
  }
  for (const f of flips) {
    console.log(`  탈락 ${f.row.violation}  ${f.from.toFixed(2)} → ${f.to.toFixed(2)}  [${f.row.set}/${f.row.kind}]`);
  }
  console.log(`\n비겨냥 라벨 새 탈락 ${flips.length}건 · 겨냥 라벨 새 탈락 ${targetNewFails}건`);
  if (flips.length >= 2 && targetNewFails === 0) {
    console.log(
      '\n✗ **시소 간섭 발동** — 새 과목을 배우며 안 배운 과목을 덮어썼습니다.\n' +
        '  즉시 110M 부검 런: 같은 데이터·같은 설정으로 KoELECTRA-base 학습 후 게이트만 실행.\n' +
        '  (base 통과 = 용량 한계 / base 실패 = 신규 자료의 라벨 노이즈 — 26차 CC-5 감별식)\n' +
        '  ⚠ gap 17형 주의: 탈락이 학습률 과대(가중치 파괴)일 수도 있습니다 — 검토자 반증 조건.',
    );
    process.exitCode = 1;
  } else if (flips.length >= 2) {
    // 정의(겨냥 전건 통과)는 비켜갔지만 비겨냥 하락 자체가 용량 신호다 — r8(2026-08-22)에서
    // 겨냥 1건 탈락 때문에 이 가지로 빠져 "없음"으로 읽힐 뻔했다. 28차 EE-5 반증 조건
    // ("90쌍 주입에도 채점지 전반 하락 = 14M 포화")은 겨냥 통과 여부와 무관하다.
    console.log(
      `\n⚠ **용량 경보** — 비겨냥 라벨 새 탈락 ${flips.length}건 (겨냥도 ${targetNewFails}건 탈락이라 ` +
        '시소 정의에는 안 맞음). 그릇이 넘친 모양 — 주입 취소·110M 부검 검토.',
    );
    process.exitCode = 1;
  } else {
    console.log('✓ 시소 간섭 없음');
  }
}
main();
