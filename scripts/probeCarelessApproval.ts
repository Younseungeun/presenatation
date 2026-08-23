import type { Finding } from '../src/domain/compliance';
import type { LabeledReview } from '../src/domain/screeningAccuracy';
import { ROLLBACK_WINDOW, studentRollbackStatus } from '../src/domain/studentRollback';

// **운영자가 빨리 승인하면 어떻게 되는가** — 자동 격하의 입력이 무엇으로 만들어지는지 잰다.
//
//   npx tsx scripts/probeCarelessApproval.ts
//
// ── 이 스크립트가 존재하는 이유 ────────────────────────────────────
// 10차에 이 측정이 결함 하나를 드러냈다. 승인의 기본 라벨은 **오탐**이고
// (screeningAccuracy.classifyReview), 그 근거는 정확도 표시용으로는 타당하다.
// 그런데 그 라벨이 자동 격하의 입력이 되면서 λ=4 가 같은 방향으로 증폭했고,
// **25건 중 6건만 무심코 승인해도 학생이 영구히 꺼졌다.**
//
// 11차 K-1 이 지표용 라벨과 억제 신호를 갈랐다. 아래 ②가 그 수정이 살아 있는지 본다 —
// 숫자가 다시 음수로 돌아오면 어딘가에서 두 라벨이 다시 붙은 것이다.

const finding: Finding = {
  category: 'PRIVATE_INFO',
  severity: 'WARN',
  quote: '',
  reason: '학생 모델',
  source: 'student',
};

/** 아무 표시 없이 승인 — 11차 K-1 이후 격하 표본이 아니다 */
const silent = (): LabeledReview => ({
  decision: 'WARN',
  findings: [finding],
  verdict: 'APPROVED',
  findingsValid: null,
  actualCategories: [],
});

/** 운영자가 명시적으로 오탐이라고 신고 */
const reported = (): LabeledReview => ({
  decision: 'WARN',
  findings: [finding],
  verdict: 'APPROVED',
  findingsValid: false,
  actualCategories: [],
});

/** 반려 — 학생이 맞았다 */
const genuine = (): LabeledReview => ({
  decision: 'WARN',
  findings: [finding],
  verdict: 'REJECTED',
  findingsValid: null,
  actualCategories: [],
});

const half = Math.ceil(ROLLBACK_WINDOW / 2);
console.log(`\n창 ${ROLLBACK_WINDOW}건 · 표본 하한 ${half}건 · λ=4\n`);

console.log('① 아무 표시 없이 빠르게 승인한 건이 섞이면 (11차 K-1 이후)');
console.log('  무표시승인  표본  정탐  순이익  격하');
for (const n of [0, 3, 6, 10, 25]) {
  const s = studentRollbackStatus([
    ...Array.from({ length: n }, silent),
    ...Array.from({ length: half - Math.min(n, half) }, genuine),
  ]);
  console.log(
    `  ${String(n).padStart(10)}건  ${String(s.scored).padStart(4)}  ` +
      `${String(s.caught).padStart(4)}  ${String(s.netValue).padStart(6)}  ` +
      `${s.shouldRollback ? '✗ 꺼진다' : '유지'}`,
  );
}
console.log('  ※ 10차에는 무표시 승인 6건이면 순이익 −5 로 꺼졌다\n');

console.log('② 명시적으로 신고하면 그대로 격하된다 — 의도된 신호는 죽이지 않았다');
console.log('  명시적신고  표본  정탐  순이익  격하');
for (const fp of [3, 5, 6, 10]) {
  const s = studentRollbackStatus([
    ...Array.from({ length: fp }, reported),
    ...Array.from({ length: half - fp }, genuine),
  ]);
  console.log(
    `  ${String(fp).padStart(10)}건  ${String(s.scored).padStart(4)}  ` +
      `${String(s.caught).padStart(4)}  ${String(s.netValue).padStart(6)}  ` +
      `${s.shouldRollback ? '✗ 꺼진다' : '유지'}`,
  );
}
console.log('');
