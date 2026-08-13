import { ASSET_CLASSES, type AssetClass, type Direction } from './constants';

// 규율 증거의 집계 — **상관 보정** (2026-08-13).
//
// ── 무엇이 문제였나 ───────────────────────────────────────────
// 규율 래더(scoring.DISCIPLINE_LADDER)는 카드별 정보량의 합 D를 본다:
//
//     D = Σ ln( L_i(신고한 확률) / L_i(무정보) )
//
// Ville 부등식 P(∃t: D ≤ −ln(1/α)) ≤ α 는 1/Λ가 평균 1의 비음 마팅게일일 때
// 성립한다. 그러려면 각 항이 **그때까지 드러난 결과를 알고 낸 조건부 신고**여야 하는데,
// 같은 기간에 함께 열려 있는 상관된 카드들은 그 조건을 깬다.
//
// 반도체 3종목에 같은 방향 카드를 걸면 셋이 함께 맞고 함께 틀린다. 그런데 D는
// 그것을 세 번의 독립 증거로 센다. 완전 상관 3장 묶음에서 E_P[1/Λ] = 1.75 —
// 부등식의 전제가 사라지고, 정직한 사람이 걸릴 확률이 α를 크게 넘는다.
// **실측: 정직한 신고자의 1단 오작동이 2.5%(독립) → 21.8%(3장 완전 상관)로 벌어졌다.**
// 이것은 악용이 아니라 정상적인 리서치 행동(같은 업종에 여러 카드)에서 나온다.
//
// ── 보정 ─────────────────────────────────────────────────────
// 동시에 열려 있던 같은 자산군·같은 방향 카드를 **한 묶음**으로 보고, 묶음이
// 기여하는 증거를 그 **평균** 한 항으로 줄인다. 곧 최악 가정(ρ=1)의 설계효과다:
// 완전 상관이면 묶음은 실제로 관측 한 번이므로 평균이 정확하고, 상관이 그보다
// 낮으면 실제보다 적게 세므로 **안전한 방향으로 틀린다**.
//
// 안전한 방향인 이유: 보정은 |D|를 줄이기만 한다. 래더는 D가 **내려갈 때만**
// 발동하므로, 적게 세는 것은 "덜 처분한다"는 뜻이다. 증거가 부족할 때 처분하지
// 않는 것이 이 시스템의 기본 태도와 같다.
//
// ── 묶음을 어떻게 정하나 ──────────────────────────────────────
// **결과를 보고 정하지 않는다.** 묶음 기준은 게시 시점에 이미 정해진 값(자산군·방향·
// 열려 있던 기간)뿐이다 — 결과가 좋은 카드만 골라 묶거나 나누는 여지가 있으면
// 그 자체가 새로운 악용 경로가 된다.
//
//   · 같은 자산군 — 업종 정보가 마스터에 없어 자산군을 상관의 대리변수로 쓴다.
//     같은 시장의 두 종목은 시장 베타만으로도 이미 상관돼 있다. 과하게 묶는
//     쪽이라 보수적이다(업종 단위 세분화는 이후 과제)
//   · 같은 방향 — 상관된 종목에 같은 방향이면 양의 상관, 반대 방향이면 음의
//     상관이다. 음의 상관은 D의 분산을 **줄이므로** 묶지 않아도 안전하다
//   · 열려 있던 기간이 겹침 — 카드 A가 판정되기 전에 카드 B를 게시했다면,
//     B의 신고는 A의 결과를 모르고 이뤄진 것이다. 그것이 조건부 신고가 깨지는 자리다
//
// 점수(score)에는 이 보정을 적용하지 않는다. 점수는 보상·순위이지 통계적 검정이
// 아니고, 상관된 카드로 점수를 부풀리는 것은 등급 임계값이 상대 분포로 잡혀 있어
// 저절로 상쇄된다.

/** 증거 집계의 입력 — 판정된 카드 한 장 */
export interface EvidenceCard {
  assetClass: AssetClass;
  direction: Direction;
  /** 게시 시각 (ms) — 카드가 열린 순간 */
  openedAt: number;
  /** 판정 시각 (ms) — 카드가 닫힌 순간 */
  closedAt: number;
  /** 가중 전 정보량 (Judgment.info) */
  info: number;
}

export type CorrelationCorrection = 'NONE' | 'MEAN' | 'FIRST';

/**
 * 채택된 보정 방식 — **MEAN** (묶음의 평균을 한 항으로).
 *
 * 후보 비교 (scripts/simEvidenceCorrelation.ts, n=60,000):
 *
 *   정직한 신고자의 1단 오작동 (목표 ≤ 5%)     보정없음 / 평균 / 대표1장
 *     1장 독립                                   3.62% / 3.50% / 3.46%
 *     3장 × ρ0.6                                 8.08% / 0.21% / 2.13%
 *     3장 × ρ1.0                                21.12% / 2.11% / 2.08%
 *     5장 × ρ1.0                                41.34% / 1.93% / 1.99%
 *
 *   표적 탐지력 (무실력 + c=10)                 보정없음 / 평균 / 대표1장
 *     3장 × ρ0.6                                100.0% / 99.9% / 99.6%
 *     5장 × ρ0.6                                 99.8% / 98.9% / 95.7%
 *
 * 평균과 대표1장 모두 보장을 되살리지만 **평균이 두 지표 모두에서 낫다.**
 * 평균은 묶음 안의 잡음을 줄여 정직한 사람이 우연히 깊이 내려가는 것까지 막는
 * 반면(오작동 ↓), 표적의 손실은 체계적이라 평균해도 그대로 남는다(탐지력 유지).
 * 대표1장은 한 장의 잡음을 그대로 안고 가면서 나머지 증거를 버린다.
 *
 * ⚠ ρ가 1보다 낮을 때는 과보정이다(ρ0.6에서 0.03~0.21%). 실제 상관을 재서
 * 설계효과 n/(1+(n−1)ρ)를 쓰면 탐지력을 더 남길 수 있지만, 종목 간 상관을 재려면
 * 수익률 시계열을 저장해야 한다 — 지금은 σ만 저장한다. 이후 과제.
 */
export const CORRELATION_CORRECTION: CorrelationCorrection = 'MEAN';

interface Cluster {
  key: string;
  /** 묶음이 열려 있던 구간 — 새 카드가 여기에 겹치면 같은 묶음이다 */
  from: number;
  to: number;
  infos: number[];
}

/**
 * 판정된 카드들 → 자산군별 규율 증거 D.
 *
 * @param cards 시즌 안에서 판정된 카드 (순서 무관 — 게시 시각으로 정렬한다)
 * @param mode  보정 방식 (기본 CORRELATION_CORRECTION)
 */
export function clusterEvidence(
  cards: readonly EvidenceCard[],
  mode: CorrelationCorrection = CORRELATION_CORRECTION,
): Record<AssetClass, number> {
  const out = Object.fromEntries(ASSET_CLASSES.map((a) => [a, 0])) as Record<AssetClass, number>;
  if (mode === 'NONE') {
    for (const c of cards) out[c.assetClass] += c.info;
    return out;
  }

  // 게시 순서로 훑으며 묶는다 — 결과가 아니라 시각만 본다
  const sorted = [...cards].sort((a, b) => a.openedAt - b.openedAt || a.closedAt - b.closedAt);
  const open: Cluster[] = [];
  for (const card of sorted) {
    const key = `${card.assetClass}|${card.direction}`;
    // 같은 자산군·방향이면서 아직 열려 있던 구간과 겹치는 묶음을 찾는다
    const found = open.find((c) => c.key === key && card.openedAt < c.to);
    if (found) {
      found.infos.push(card.info);
      found.to = Math.max(found.to, card.closedAt);
    } else {
      open.push({ key, from: card.openedAt, to: card.closedAt, infos: [card.info] });
    }
  }

  for (const c of open) {
    const assetClass = c.key.split('|')[0] as AssetClass;
    out[assetClass] +=
      mode === 'FIRST' ? c.infos[0] : c.infos.reduce((a, b) => a + b, 0) / c.infos.length;
  }
  return out;
}
