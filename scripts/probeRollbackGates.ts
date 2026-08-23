import type { Finding } from '../src/domain/compliance';
import type { LabeledReview } from '../src/domain/screeningAccuracy';
import {
  ROLLBACK_WINDOW,
  studentRollbackStatus,
  wilsonLowerBound,
} from '../src/domain/studentRollback';

// 자동 격하의 **두 관문이 실제로 어디서 무는지** 눈으로 본다 (11차 K-1·K-2).
//
//   npx tsx scripts/probeRollbackGates.ts
//
// 시험은 성질을 고정하고, 이 스크립트는 **경계를 보여준다.** 둘 다 필요한 이유는
// "5건 중 3건에서 격발한다"가 시험에는 안 적혀 있어도 운영자에게는 알아야 할 값이라서다.

const finding: Finding = {
  category: 'PRIVATE_INFO',
  severity: 'WARN',
  quote: '',
  reason: '학생 모델',
  source: 'student',
};

/** 운영자가 **명시적으로** 오탐이라고 신고 — 격하 표본이 된다 */
const reported = (): LabeledReview => ({
  decision: 'WARN',
  findings: [finding],
  verdict: 'APPROVED',
  findingsValid: false,
  actualCategories: [],
});

/** 아무 표시 없이 승인 — 정확도에는 오탐, 격하에는 **표본이 아니다** */
const silent = (): LabeledReview => ({
  decision: 'WARN',
  findings: [finding],
  verdict: 'APPROVED',
  findingsValid: null,
  actualCategories: [],
});

/** 반려 — 학생이 맞았다 */
const caught = (): LabeledReview => ({
  decision: 'WARN',
  findings: [finding],
  verdict: 'REJECTED',
  findingsValid: null,
  actualCategories: [],
});

const rows = (n: number, fp: number) => [
  ...Array.from({ length: fp }, reported),
  ...Array.from({ length: n - fp }, caught),
];

console.log('\n① 출시 직후 (윌슨 하한) — 표본 5건에서 명시적 오탐이 몇 건이면 꺼지는가');
console.log('  표본  오탐   하한   판정근거      결과');
for (const [n, fp] of [[5, 1], [5, 2], [5, 3], [5, 4], [5, 5], [1, 1], [3, 3]] as const) {
  const s = studentRollbackStatus(rows(n, fp));
  console.log(
    `  ${String(n).padStart(4)}  ${String(fp).padStart(4)}  ` +
      `${(s.falsePositiveRateLowerBound * 100).toFixed(1).padStart(5)}%  ` +
      `${s.basis.padEnd(12)}  ${s.shouldRollback ? '✗ 꺼진다' : '유지'}`,
  );
}

console.log('\n② 10차에 찾은 결함 — 성의 없는 승인(무표시)만 25건');
const careless = studentRollbackStatus(Array.from({ length: 25 }, silent));
console.log(`  ${careless.summary}`);
console.log(`  격하: ${careless.shouldRollback}  ← 10차에는 true 였다 (순이익 −100)`);

console.log('\n③ 그중 여섯 건을 명시적으로 신고했다면 — 의도된 신호는 그대로 산다');
const six = studentRollbackStatus([
  ...Array.from({ length: 6 }, reported),
  ...Array.from({ length: 19 }, silent),
]);
console.log(`  ${six.summary}`);
console.log(`  격하: ${six.shouldRollback}`);

console.log('\n④ 표본이 창의 절반을 넘으면 순이익 규칙 (채택선과 같은 공식)');
for (const fp of [5, 6]) {
  const s = studentRollbackStatus(rows(ROLLBACK_WINDOW / 2, fp));
  console.log(
    `  25건 중 명시적 오탐 ${fp}건 → ${s.basis} · 순이익 ${s.netValue} · ` +
      `${s.shouldRollback ? '✗ 꺼진다' : '유지'}`,
  );
}

console.log('\n[윌슨 하한 표] 오탐 k/n 의 95% 하한 — 표본이 쌓일수록 단순 비율에 수렴한다');
for (const n of [5, 10, 25, 50]) {
  const cells = [1, 2, 3, 5].map((k) => `k=${k}: ${(wilsonLowerBound(k, n) * 100).toFixed(1)}%`);
  console.log(`  n=${String(n).padStart(2)}  ${cells.join('  ')}`);
}
console.log('');
