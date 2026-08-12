// 판매 중단 구간(1구간)·고지 허용 오차 산정 시뮬레이션 — npx tsx scripts/simSalesBand.ts
//
// 설계 전제 (2026-08-10 사용자 확정):
//   판매 마감(불가역) = 일봉 종가가 목표를 넘음 → 판정과 같은 사건
//   판매 중단(가역)   = 장중, 남은 수익률이 "1구간"을 벗어남. 벗어나 있는 동안 계속 중단
//   판매 전 고지      = 구간 안이지만 광고 수익률을 다 못 챙길 때(최소 보장) /
//                       반대로 허용 오차 이상 벌어져 초과 수익이 될 때
//
// 산정 대상 두 값:
//   α (1구간 바닥)  — 남은 수익률 / 광고 수익률 이 α 밑이면 판매 중단
//   τ (허용 오차)   — |남은/광고 − 1| ≤ τ 이면 고지 없음
//
// 방법: 무배당 GBM 일봉 (드리프트 0 = 정보 없는 시장, 보수적).
//   q_t = ((목표가 − 현재가)/현재가) / 광고수익률  ← "리포트대로 행동 시 남은 몫"
//   적중 = 어느 날 종가가 목표 이상 (통합 판정 규칙과 동일)
//   판매 가능일 = 판매 기간(min(H/3, 30일)) 안이고 아직 적중 전
//
// 읽는 법:
//   중단일%      — 판매 가능일 중 q<α인 날의 비율 (종가 기준; 장중은 1.2~1.4배쯤 더 잦다)
//   중단경험%    — 판매 기간에 한 번이라도 중단을 겪는 카드 비율
//   경계구매 적중 — q≈α에서 산 사람의 최종 적중 확률 (게시 직후 구매자 대비)
//   상태변화/일  — 고지 상태(부족/없음/초과)가 하루 사이 바뀌는 빈도 (깜빡임 지표)

interface Config {
  label: string;
  sigma: number; // 일 변동성
  M: number; // 광고 수익률 (예: 0.1 = +10%)
  H: number; // 검증 기간 (일)
}

const CONFIGS: Config[] = [
  { label: '주식 +5%/30일', sigma: 0.02, M: 0.05, H: 30 },
  { label: '주식 +10%/60일', sigma: 0.02, M: 0.1, H: 60 },
  { label: '주식 +15%/90일', sigma: 0.02, M: 0.15, H: 90 },
  { label: '코인 +10%/14일', sigma: 0.04, M: 0.1, H: 14 },
  { label: '코인 +20%/30일', sigma: 0.04, M: 0.2, H: 30 },
  { label: '코인 +30%/60일', sigma: 0.04, M: 0.3, H: 60 },
];

const ALPHAS = [0.3, 0.4, 0.5, 0.6, 0.7];
const TAUS = [0.1, 0.15, 0.2, 0.25, 0.3];
const N_PATHS = 8000;

let seed = 20260810;
function rand(): number {
  // xorshift — 재현 가능한 난수
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) as number) / 0xffffffff;
}
function gauss(): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface PathObs {
  /** 판매 가능일별 q */
  qByDay: number[];
  /** 그 날 이후(시한까지) 적중했는가 — 그 날 산 사람의 결과 */
  hitAfter: boolean[];
  hitAtAll: boolean;
}

function simulatePath(cfg: Config): PathObs {
  const W = Math.min(Math.ceil(cfg.H / 3), 30);
  const target = 1 + cfg.M;
  let s = 1;
  const closes: number[] = [];
  for (let t = 0; t < cfg.H; t++) {
    s *= Math.exp(-0.5 * cfg.sigma * cfg.sigma + cfg.sigma * gauss());
    closes.push(s);
  }
  const hitDay = closes.findIndex((c) => c >= target); // -1 = 미적중
  const qByDay: number[] = [];
  const hitAfter: boolean[] = [];
  const sellableEnd = hitDay >= 0 ? Math.min(W, hitDay) : W;
  for (let t = 0; t < sellableEnd; t++) {
    const q = (target - closes[t]) / closes[t] / cfg.M;
    qByDay.push(q);
    hitAfter.push(hitDay > t);
  }
  return { qByDay, hitAfter, hitAtAll: hitDay >= 0 };
}

function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5) + '%';
}

for (const cfg of CONFIGS) {
  const paths: PathObs[] = [];
  for (let i = 0; i < N_PATHS; i++) paths.push(simulatePath(cfg));

  const pubHit = paths.filter((p) => p.hitAtAll).length / N_PATHS;
  console.log(`\n━━ ${cfg.label}  (게시 직후 구매자 적중률 ${pct(pubHit)}) ━━`);

  // ── α: 중단 구간 ──
  console.log('  α(구간바닥)  중단일%  중단경험%  경계구매 적중률(절대/게시대비)');
  for (const a of ALPHAS) {
    let suspDays = 0;
    let totalDays = 0;
    let everSusp = 0;
    let boundaryBuy = 0;
    let boundaryHit = 0;
    for (const p of paths) {
      let any = false;
      for (let t = 0; t < p.qByDay.length; t++) {
        totalDays++;
        const q = p.qByDay[t];
        if (q < a) {
          suspDays++;
          any = true;
        }
        if (q >= a && q < a + 0.05) {
          boundaryBuy++;
          if (p.hitAfter[t]) boundaryHit++;
        }
      }
      if (any) everSusp++;
    }
    const bHit = boundaryBuy > 0 ? boundaryHit / boundaryBuy : NaN;
    console.log(
      `     ${a.toFixed(1)}      ${pct(suspDays / totalDays)}   ${pct(everSusp / N_PATHS)}    ${pct(bHit)} / ${(bHit / pubHit).toFixed(2)}배`,
    );
  }

  // ── τ: 고지 허용 오차 ──
  console.log('  τ(허용오차)  부족고지%  고지없음%  초과고지%  상태변화/일');
  for (const tau of TAUS) {
    let low = 0;
    let mid = 0;
    let high = 0;
    let flips = 0;
    let pairs = 0;
    for (const p of paths) {
      let prev = -1;
      for (const q of p.qByDay) {
        const state = q < 1 - tau ? 0 : q > 1 + tau ? 2 : 1;
        if (state === 0) low++;
        else if (state === 1) mid++;
        else high++;
        if (prev >= 0) {
          pairs++;
          if (state !== prev) flips++;
        }
        prev = state;
      }
    }
    const days = low + mid + high;
    console.log(
      `     ${tau.toFixed(2)}     ${pct(low / days)}   ${pct(mid / days)}   ${pct(high / days)}    ${(flips / pairs).toFixed(3)}`,
    );
  }

  // ── 참고: 반대 방향으로 벌어진 구매자의 실제 적중률 ──
  let revBuy = 0;
  let revHit = 0;
  for (const p of paths) {
    for (let t = 0; t < p.qByDay.length; t++) {
      if (p.qByDay[t] > 1.3) {
        revBuy++;
        if (p.hitAfter[t]) revHit++;
      }
    }
  }
  if (revBuy > 0) {
    console.log(
      `  참고: 역방향 괴리(q>1.3)에서 산 사람의 적중률 ${pct(revHit / revBuy)} (게시 직후의 ${(revHit / revBuy / pubHit).toFixed(2)}배)`,
    );
  }
}

// ── 추가 실험: 초과 쪽 문턱을 따로 두면 (비대칭 τ) ─────────────────
// 초과 상태가 기본이 되는 것은 τ가 작아서가 아니라 **분포가 비대칭이라서다**:
// 가격이 빠지면 q = (T−S)/S/M 가 빠르게 부풀어 오른다(분모·분자 양쪽에서).
// 부족 쪽 문턱은 0.2로 고정하고 초과 쪽만 키워 보면 얼마나 드물어지는지 잰다.
console.log('\n━━ 비대칭 τ: 부족쪽 0.2 고정, 초과쪽 문턱별 "초과 고지" 일수 비율 ━━');
console.log('  구성            >1.3   >1.5   >1.7   >2.0');
for (const cfg of CONFIGS) {
  seed = 20260810; // 같은 경로 재현
  const shares = new Map<number, number>([[1.3, 0], [1.5, 0], [1.7, 0], [2.0, 0]]);
  let days = 0;
  for (let i = 0; i < N_PATHS; i++) {
    const p = simulatePath(cfg);
    for (const q of p.qByDay) {
      days++;
      for (const th of shares.keys()) if (q > th) shares.set(th, shares.get(th)! + 1);
    }
  }
  const row = [...shares.values()].map((n) => pct(n / days)).join(' ');
  console.log(`  ${cfg.label.padEnd(14)} ${row}`);
}
