/**
 * 장중 시세 감시 부하 시뮬 — 감시 대상(watching) 종목 수가 회차 상한(60)을 언제·얼마나
 * 넘는가. B(지연 지속 알람)의 문턱 N을 정하려는 것.
 *
 * "지연(slow)"의 실체(장중 감시 60-cap):
 *   · 카드는 남은 몫 q < 1.0 이면 감시 편입, q > 1.4 연속 3회면 해제 (domain/quoteWatch.ts).
 *   · 감시 대상이 60을 넘으면 그 회차에 다 못 돌아 skipped>0 = 지연 (quoteWatchService.ts).
 *   · 2분 주기(QUOTE_INTERVAL_MS), 장중에만.
 *
 * 재현하는 실제 상수: WATCH_ENTER_Q 1.0 / WATCH_EXIT_Q 1.4 / WATCH_EXIT_STREAK 3 /
 *   SUSPEND_ALPHA 0.5 / refreshWatchedQuotes limit 60 / 2분 주기.
 *
 * 모델: 시장별로 활성 카드 N장을 고정 유지(하나 떠나면 즉시 새 카드로 교체 = 정상상태).
 *   각 카드는 기준가 대비 유리 방향 누적수익 g 를 GBM 으로 걷는다(드리프트 0). q = 1 - g/M.
 *   장중 2분마다 g 를 조금 걷고, 며칠에 한 번 시장 전체 충격(상관 이동)을 준다.
 *   q≤0(적중)·q≥2(역행 마감)·기한 도래면 카드가 나가고 새 카드로 교체된다.
 *
 * @근거 시뮬 이 파일 — 감시 편입/해제 규칙과 60 상한을 그대로 재현해 부하를 잰다
 */

// ── 재현 상수 (실제 코드에서) ───────────────────────────────
const CAP = 60; // refreshWatchedQuotes limit
const ENTER = 1.0; // WATCH_ENTER_Q
const EXIT = 1.4; // WATCH_EXIT_Q
const EXIT_STREAK = 3; // WATCH_EXIT_STREAK
const TICKS_PER_DAY = 195; // 6.5시간 정규장 / 2분
const DT = 1 / TICKS_PER_DAY; // 하루를 1로 본 한 틱의 분산 비중

// ── RNG (재현 가능) ────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeNormal(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
}

// ── 카드 표본 뽑기 ─────────────────────────────────────────
interface Card {
  sigma: number; // 일간 변동성 (fractional)
  M: number; // 광고 폭 (fractional). q = 1 - g/M
  deadlineDays: number;
  dir: number; // +1/-1 — 시장 충격의 상관 방향
  g: number; // 유리 방향 누적수익
  ageTicks: number;
  watching: boolean;
  exitStreak: number;
}

// 프로피터빌리티 5구간(45/21/22/11/2%)의 대표 배수 (하한 F 대비)
const BUCKET_MULT = [1.25, 1.75, 2.5, 4.0, 6.0];
const BUCKET_CUM = [0.45, 0.66, 0.88, 0.99, 1.0];

function sampleCard(rng: () => number, normal: () => number, medianSigma: number): Card {
  // σ: 로그정규, 시장 중앙값 중심, [0.2%,25%] 클립 (stability 안전범위와 동일)
  let sigma = medianSigma * Math.exp(0.55 * normal());
  sigma = Math.min(0.25, Math.max(0.002, sigma));
  // 기한: 50% [7,30], 30% (30,90], 20% (90,365]
  const u = rng();
  let deadlineDays: number;
  if (u < 0.5) deadlineDays = 7 + rng() * 23;
  else if (u < 0.8) deadlineDays = 30 + rng() * 60;
  else deadlineDays = 90 + rng() * 275;
  // 크기 하한 F = 1.2·σ·√기한 (종목변동성 연동), M = F × 구간배수
  const floor = 1.2 * sigma * Math.sqrt(deadlineDays);
  const b = rng();
  let bi = 0;
  while (bi < BUCKET_CUM.length - 1 && b > BUCKET_CUM[bi]) bi++;
  const M = Math.max(0.01, floor * BUCKET_MULT[bi]);
  return {
    sigma,
    M,
    deadlineDays,
    dir: rng() < 0.5 ? 1 : -1,
    g: 0,
    ageTicks: 0,
    watching: false,
    exitStreak: 0,
  };
}

// ── 한 시장 시뮬 ───────────────────────────────────────────
interface MarketResult {
  meanWatch: number;
  p50: number;
  p95: number;
  p99: number;
  maxWatch: number;
  pctSlowTicks: number;
  sessions: number;
  fullSlowSessions: number; // 세션 내내 slow
  breaches: number; // 세션 내 연속 slow 구간 수
  runMinP50: number;
  runMinP90: number;
  runMinP99: number;
  runMinMax: number;
  clearedWithin: Record<number, number>; // {10,20,30,60} 분 안에 끝난 breach 수
}

function simMarket(
  seed: number,
  activeN: number,
  medianSigma: number,
  measuredDays: number,
  warmupDays: number,
  shockDailyProb: number,
): MarketResult {
  const rng = mulberry32(seed);
  const normal = makeNormal(rng);

  const cards: Card[] = [];
  for (let i = 0; i < activeN; i++) cards.push(sampleCard(rng, normal, medianSigma));
  // 나이 분포를 정상상태로: 무작위 나이만큼 미리 걸어 둔다
  for (const c of cards) {
    const preDays = rng() * c.deadlineDays;
    c.ageTicks = Math.floor(preDays * TICKS_PER_DAY);
    c.g = normal() * c.sigma * Math.sqrt(Math.max(0.01, preDays));
    updateWatch(c, false);
  }

  const sqrtDt = Math.sqrt(DT);
  const watchCounts: number[] = [];
  const runsMin: number[] = [];
  const clearedWithin: Record<number, number> = { 10: 0, 20: 0, 30: 0, 60: 0 };
  let slowTicks = 0;
  let totalTicks = 0;
  let sessions = 0;
  let fullSlowSessions = 0;
  let breaches = 0;

  const totalDays = warmupDays + measuredDays;
  for (let day = 0; day < totalDays; day++) {
    const measuring = day >= warmupDays;
    // 오늘 시장 충격? (상관 이동)
    const shockToday = rng() < shockDailyProb;
    const shockTick = shockToday ? Math.floor(rng() * TICKS_PER_DAY) : -1;
    const shockMag = shockToday ? (0.02 + rng() * 0.04) * (rng() < 0.5 ? 1 : -1) : 0;

    let sessionSlowTicks = 0;
    let curRun = 0;
    if (measuring) sessions++;

    for (let t = 0; t < TICKS_PER_DAY; t++) {
      // 카드 진행
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        c.ageTicks++;
        c.g += normal() * c.sigma * sqrtDt;
        if (t === shockTick) c.g += c.dir * shockMag * (0.5 + 0.5 * rng());
        updateWatch(c, false);
        // 이탈 판정 → 교체
        const q = c.M > 0 ? 1 - c.g / c.M : 1;
        const ageDays = c.ageTicks / TICKS_PER_DAY;
        if (q <= 0 || q >= 2 || ageDays >= c.deadlineDays) {
          cards[i] = sampleCard(rng, normal, medianSigma);
        }
      }
      let wc = 0;
      for (const c of cards) if (c.watching) wc++;
      const slow = wc > CAP;
      if (measuring) {
        totalTicks++;
        watchCounts.push(wc);
        if (slow) {
          slowTicks++;
          sessionSlowTicks++;
          curRun++;
        } else if (curRun > 0) {
          const mins = curRun * 2;
          runsMin.push(mins);
          for (const th of [10, 20, 30, 60]) if (mins <= th) clearedWithin[th]++;
          breaches++;
          curRun = 0;
        }
      }
    }
    // 세션 끝: 종가 관측으로 해제 한 번 (atClose)
    for (const c of cards) updateWatch(c, true);
    if (measuring) {
      if (curRun > 0) {
        const mins = curRun * 2;
        runsMin.push(mins);
        for (const th of [10, 20, 30, 60]) if (mins <= th) clearedWithin[th]++;
        breaches++;
      }
      if (sessionSlowTicks === TICKS_PER_DAY) fullSlowSessions++;
    }
  }

  watchCounts.sort((a, b) => a - b);
  runsMin.sort((a, b) => a - b);
  const pct = (arr: number[], p: number) =>
    arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0;
  return {
    meanWatch: watchCounts.reduce((a, b) => a + b, 0) / (watchCounts.length || 1),
    p50: pct(watchCounts, 50),
    p95: pct(watchCounts, 95),
    p99: pct(watchCounts, 99),
    maxWatch: watchCounts[watchCounts.length - 1] ?? 0,
    pctSlowTicks: totalTicks ? (100 * slowTicks) / totalTicks : 0,
    sessions,
    fullSlowSessions,
    breaches,
    runMinP50: pct(runsMin, 50),
    runMinP90: pct(runsMin, 90),
    runMinP99: pct(runsMin, 99),
    runMinMax: runsMin[runsMin.length - 1] ?? 0,
    clearedWithin,
  };
}

function updateWatch(c: Card, atClose: boolean): void {
  const q = c.M > 0 ? 1 - c.g / c.M : 1;
  if (!c.watching) {
    c.watching = q < ENTER;
    c.exitStreak = 0;
    return;
  }
  if (q <= EXIT) {
    c.exitStreak = 0;
    return;
  }
  const streak = c.exitStreak + 1;
  const release = atClose || streak >= EXIT_STREAK;
  c.watching = !release;
  c.exitStreak = release ? 0 : streak;
}

// ── 청사진 시나리오 ────────────────────────────────────────
// 활성 카드 = 게시·미판정·미철회로 슬롯을 점유하는 카드. 시장별.
interface Scenario {
  name: string;
  markets: { KR: number; US: number; CRYPTO: number };
}
const SCENARIOS: Scenario[] = [
  { name: '씨앗 (0~6개월, 리서처 ~30)', markets: { KR: 50, US: 15, CRYPTO: 30 } },
  { name: '초기 (~12개월, 리서처 ~60)', markets: { KR: 120, US: 40, CRYPTO: 70 } },
  { name: '성장 전환 (~18개월, 리서처 ~150)', markets: { KR: 260, US: 90, CRYPTO: 150 } },
  { name: '성장 (~24개월, 리서처 ~300)', markets: { KR: 550, US: 200, CRYPTO: 320 } },
];
const MEDIAN_SIGMA = { KR: 0.02, US: 0.02, CRYPTO: 0.04 };
const MEASURED = 60;
const WARMUP = 40;
const SHOCK_PROB = 0.06; // 하루 6% 확률로 시장 전체 충격

console.log('장중 시세 감시 부하 시뮬 (감시 상한 60, 2분 주기)\n');
console.log(
  '시나리오별로 감시 대상 종목 수(watching)와 60 초과 지연의 지속 시간을 잰다.\n' +
    '핵심 질문: (1) 어느 규모에서 지연이 상시화(구조적)되나 (2) 정상 범위에서 지연은 몇 분 만에 끝나나\n',
);

for (const sc of SCENARIOS) {
  console.log(`\n━━━ ${sc.name} ━━━`);
  for (const mk of ['KR', 'US', 'CRYPTO'] as const) {
    const activeN = sc.markets[mk];
    const r = simMarket(
      0x51 + activeN * 7 + mk.length,
      activeN,
      MEDIAN_SIGMA[mk],
      MEASURED,
      WARMUP,
      SHOCK_PROB,
    );
    const structural = r.pctSlowTicks > 50; // 절반 이상 지연 = 구조적
    console.log(
      `  ${mk.padEnd(6)} 활성 ${String(activeN).padStart(3)}장 | ` +
        `감시 평균 ${r.meanWatch.toFixed(0).padStart(3)} (p95 ${String(r.p95).padStart(3)}, 최대 ${String(r.maxWatch).padStart(3)}) | ` +
        `지연 틱 ${r.pctSlowTicks.toFixed(1).padStart(5)}% ` +
        (structural ? '← 구조적(상시)' : ''),
    );
    if (r.breaches > 0) {
      const cw = r.clearedWithin;
      console.log(
        `         지연 구간 ${r.breaches}회 | 지속(분) p50 ${r.runMinP50} · p90 ${r.runMinP90} · p99 ${r.runMinP99} · 최대 ${r.runMinMax} | ` +
          `세션내내지연 ${r.fullSlowSessions}/${r.sessions}`,
      );
      console.log(
        `         10분내 종료 ${cw[10]} · 20분 ${cw[20]} · 30분 ${cw[30]} · 60분 ${cw[60]} (전체 ${r.breaches})`,
      );
    }
  }
}
console.log('\n(측정 60 거래일 × 195틱, 워밍업 40일, 시장충격 하루 6%)');
