// 판매 기간(시간 규칙) 결정 — npx tsx scripts/simSalesWindow.ts
//
// 질문: 가격 규칙(잔여 수익률이 구간 바닥×2/3 밑이면 판매 마감)이 이미 있는데,
// 시간으로는 언제 판매를 끊어야 하는가?
//
// 시뮬로 정할 수 있는 것과 없는 것을 나눈다:
//  · 정할 수 있는 것 — 늦게 산 구매자의 "적중 확률 붕괴" 지점. 가격 규칙이 열어 둔
//    카드라도(위로 안 간 카드) 시간이 깎이면 남은 기간에 목표를 갈 확률이 무너진다.
//    성과 연동 환불이 돈은 지켜 주지만, 거의 확실히 환불될 카드를 파는 것은
//    양쪽 모두에게 무가치하다(리서처도 선결제 0%면 한 푼도 못 받는다).
//  · 정할 수 없는 것 — 논지의 신선도(절대 상한). 분석이 낡는 속도는 가격 모델로
//    흉내 낼 수 없다. 절대 상한 30일은 판단으로 두고 운영 데이터로 조정한다.
//
// 모델 (가정은 전부 초안 — 운영 데이터로 교체):
//  · 일간 수익률 ~ N(0, σ): 주식 σ=2%/일, 코인 σ=4.5%/일 (무드리프트 —
//    드리프트를 넣으면 "예측이 맞는 세계"를 가정하는 셈이라 보수적으로 0)
//  · 신고 크기 M = L×F, L ~ LogNormal(중앙값 1.6, σ0.55) 절단 1.0
//    (simProfitabilityBuckets와 동일 분포)
//  · 적중 = 시한 시점 실현 ≥ M (현행 만기형 판정)
//  · 판매 열림 = 잔여 수익률 ≥ 구간 바닥×2/3 (가격 규칙 생존)
//
// 지표: 시점 τ/T에 "아직 판매 중"인 카드를 산 구매자의 적중 확률이
// 게시 직후 구매자 대비 얼마나 남았는가 (유지율). 유지율이 절반 아래로
// 무너지는 지점이 시간 규칙의 근거가 된다.

import { PROFITABILITY_BOUNDS } from '../src/domain/profitability';

const PATHS = 40_000;

function randn(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 표준정규 CDF (Zelen & Severo 근사) */
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** 지금 가격 p(기준가=1), 남은 일수 d에서 시한 내 실현 ≥ M일 확률 (만기형) */
function pHit(p: number, remainDays: number, M: number, sigma: number): number {
  if (remainDays <= 0) return p >= 1 + M ? 1 : 0;
  const s = sigma * Math.sqrt(remainDays);
  return 1 - phi(Math.log((1 + M) / p) / s);
}

function bandFloor(L: number): number {
  let floor = 1;
  for (const b of PROFITABILITY_BOUNDS) if (L >= b) floor = b;
  return floor;
}

const CLOSE_RATIO = 2 / 3;

function run(label: string, sigma: number, T: number) {
  // 카드 표본
  const cards = Array.from({ length: PATHS }, () => {
    const L = Math.max(1, Math.exp(Math.log(1.6) + 0.55 * randn()));
    return { M: L, floor: bandFloor(L) }; // F 배수 좌표계 그대로 (F가 약분된다)
  });

  const taus = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  // M을 %로: F 배수 L → 수익률 L×F (주식 F=5%, 코인 F=10%) — sigma와 같은 단위
  const F = label === '코인' ? 0.1 : 0.05;
  const base = cards.reduce((s, c) => s + pHit(1, T, c.M * F, sigma), 0) / cards.length;

  const out: string[] = [];
  for (const tau of taus) {
    const day = Math.round(T * tau);
    let openN = 0;
    let hitSum = 0;
    for (const c of cards) {
      const M = c.M * F;
      const closeLine = c.floor * F * CLOSE_RATIO;
      // 경로 1개 진행 (카드마다 독립 경로 — 표본 수가 곧 경로 수)
      let p = 1;
      let open = true;
      for (let d = 0; d < day; d++) {
        p *= Math.exp(sigma * randn() - (sigma * sigma) / 2);
        const remaining = (1 + M) / p - 1; // 지금 사면 남은 이동
        if (remaining < closeLine) {
          open = false;
          break; // 가격 규칙이 이미 닫음 (위로 간 카드)
        }
      }
      if (!open) continue;
      openN++;
      hitSum += pHit(p, T - day, M, sigma);
    }
    const pOpen = openN / cards.length;
    const pHitOpen = openN ? hitSum / openN : 0;
    out.push(
      `   τ=${(tau * 100).toFixed(0).padStart(2)}%  열린 카드 ${(pOpen * 100).toFixed(0).padStart(3)}%  그때 산 사람 적중확률 ${(pHitOpen * 100).toFixed(1).padStart(5)}%  (게시 직후 ${(base * 100).toFixed(1)}%의 ${(base ? (pHitOpen / base) * 100 : 0).toFixed(0).padStart(3)}%)`,
    );
  }
  console.log(`■ ${label} · 검증기간 ${T}일 (σ=${sigma * 100}%/일)`);
  for (const line of out) console.log(line);
  console.log('');
}

for (const T of [7, 30, 90, 180]) run('주식', 0.02, T);
for (const T of [7, 30, 90]) run('코인', 0.045, T);
