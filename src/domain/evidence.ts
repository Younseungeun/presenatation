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
// 카드 한 장의 증거를 **자기와 기간이 겹친 만큼** 깎아서 센다.
//
//     하중_i = 1 + Σ_{j≠i} 겹친기간(i,j) / min(기간_i, 기간_j)
//     D = Σ  info_i / 하중_i
//
// 완전히 겹친 n장은 하중이 n이라 정확히 **평균 한 항**이 된다 — 최악 가정(ρ=1)의
// 설계효과다. 완전 상관이면 그 n장은 실제로 관측 한 번이므로 평균이 정확하고,
// 상관이 그보다 낮으면 실제보다 적게 세므로 **안전한 방향으로 틀린다**.
// 스쳐 지나가기만 한 카드는 겹친 비율만큼만 깎인다.
//
// 안전한 방향인 이유: 보정은 |D|를 줄이기만 한다. 래더는 D가 **내려갈 때만**
// 발동하므로, 적게 세는 것은 "덜 처분한다"는 뜻이다. 증거가 부족할 때 처분하지
// 않는 것이 이 시스템의 기본 태도와 같다.
//
// ── 왜 "묶음"이 아닌가 (2026-08-13 교체) ──────────────────────
// 처음에는 겹치는 카드를 **묶음**으로 만들고 그 평균을 한 항으로 썼다. 그 구현은
// 새 카드가 붙을 때마다 묶음의 끝을 밀었는데(`to = max(to, closedAt)`), 그러면
// **연쇄**가 생긴다: A와 B가 겹치고 B와 C가 겹치면 A와 C가 안 겹쳐도 셋이 한 묶음이다.
//
// 실제 리서처는 파도로 내지 않는다. 30일 카드를 4~5일 간격으로 꾸준히 내면
// 카드1[0,30] → 카드2[5,35] → … 가 줄줄이 붙어 **시즌 전체가 묶음 하나**가 된다.
// 그러면 D가 "가장 나쁜 카드 한 장의 정보량"보다 아래로 내려갈 수 없어
// **래더가 구조적으로 발동하지 못한다** (scripts/simEvidenceChaining.ts):
//
//     20장 × 30일 (간격 4.5일)      묶음 / 연쇄 없음 / 겹친 비율
//       유효 장수                    1.0 /  3.0 /  3.5
//       정직한 신고자 오작동         0.0% / 0.0% / 0.0%   (목표 ≤5%)
//       c=10 무실력자 탐지            84% /  99% /  99%
//       c=7  무실력자 탐지             0% /  76% /  81%
//
// c=7이 0%인 것은 잡음이 아니라 산술이다 — 묶음 하나의 평균은 카드 한 장의 실패
// 정보량(c=7이면 −1.62)보다 아래로 못 간다. 1단 문턱 −3.00에 닿을 방법이 없고,
// 2단(−4.61) 이하는 c=10으로도 닿지 못한다.
//
// 겹친 비율로 깎으면 묶음도 경계도 없어 **연쇄가 생길 자리가 없다.** 부수 효과로
// 긴 카드 한 장을 먼저 깔아 이후 카드를 전부 삼키는 경로도 막힌다(유효 장수
// 1.0 → 3.0). 파도 게시(동시에 여러 장, 파도끼리 안 겹침)에서는 옛 보정과 값이
// 정확히 같아 앞선 캘리브레이션이 그대로 유지된다.
//
// ── 무엇으로 겹침을 재나 ──────────────────────────────────────
// **결과를 보고 정하지 않는다.** 기준은 게시 시점에 이미 정해진 값(자산군·방향·
// 열려 있던 기간)뿐이다 — 결과가 좋은 카드만 골라 묶거나 나누는 여지가 있으면
// 그 자체가 새로운 악용 경로가 된다.
//
//   · 같은 자산군 — 업종 정보가 마스터에 없어 자산군을 상관의 대리변수로 쓴다.
//     같은 시장의 두 종목은 시장 베타만으로도 이미 상관돼 있다. 과하게 세는
//     쪽이라 보수적이다(업종 단위 세분화는 이후 과제)
//   · 같은 방향 — 상관된 종목에 같은 방향이면 양의 상관, 반대 방향이면 음의
//     상관이다. 음의 상관은 D의 분산을 **줄이므로** 깎지 않아도 안전하다
//   · 겹친 기간 — 카드 A가 판정되기 전에 카드 B를 게시했다면, B의 신고는 A의
//     결과를 모르고 이뤄진 것이다. 그것이 조건부 신고가 깨지는 자리이고,
//     얼마나 깨졌는지는 **겹친 정도**에 비례한다
//   · 짧은 쪽으로 나눈다 — 짧은 카드가 긴 카드 안에 통째로 들어 있으면 그 카드의
//     일생 전체가 조건부 신고를 깬 것이므로 비율이 1이어야 한다
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

export type CorrelationCorrection = 'NONE' | 'OVERLAP' | 'MEAN' | 'FIRST';

/**
 * 채택된 보정 방식 — **OVERLAP** (겹친 비율만큼 하중을 나눈다).
 *
 * ── 1차 비교: 파도 게시 (scripts/simEvidenceCorrelation.ts, n=60,000) ──
 * 동시에 여러 장을 내고 파도끼리는 겹치지 않는 구조. 여기서는 OVERLAP과 MEAN이
 * **같은 값**을 낸다(완전히 겹친 n장의 하중이 정확히 n이다).
 *
 *   정직한 신고자의 1단 오작동 (목표 ≤ 5%)     보정없음 / 평균 / 대표1장
 *     1장 독립                                   3.62% / 3.50% / 3.46%
 *     3장 × ρ1.0                                21.12% / 2.11% / 2.08%
 *     5장 × ρ1.0                                41.34% / 1.93% / 1.99%
 *
 *   표적 탐지력 (무실력 + c=10)                 보정없음 / 평균 / 대표1장
 *     5장 × ρ0.6                                 99.8% / 98.9% / 95.7%
 *
 * ── 2차 비교: 연속 게시 (scripts/simEvidenceChaining.ts, n=40,000) ──
 * 파도가 아니라 달력 시간으로 꾸준히 내는 구조. **여기서 묶음 방식이 무너진다**
 * (파일 상단 주석). 오작동은 모든 보정이 전 시나리오 0.00%였고, 갈린 것은 탐지력이다:
 *
 *   c=7 무실력자 탐지        보정없음 / 묶음 / 겹친비율
 *     8장 × 14일               82% /  0% /  79%
 *     20장 × 30일              99% /  0% /  81%
 *     30장 × 90일              91% /  0% /  23%
 *
 * ⚠ **여전히 과보정이다.** ρ=1.0까지 올려도 오작동이 0.00%다(목표 5%) — 보장을
 * 지키고 남는 여유가 크다는 뜻이고, 그만큼 탐지력을 버리고 있다. 실제 상관을 재서
 * 설계효과 n/(1+(n−1)ρ)를 쓰면 더 남길 수 있지만, 종목 간 상관을 재려면 수익률
 * 시계열을 저장해야 한다 — 지금은 σ만 저장한다. 이후 과제.
 *
 * MEAN·FIRST는 위 비교를 재현하기 위해 남겨 둔 경로다 (시뮬 전용).
 */
export const CORRELATION_CORRECTION: CorrelationCorrection = 'OVERLAP';

interface Cluster {
  key: string;
  /** 묶음이 열려 있던 구간 — 새 카드가 여기에 겹치면 같은 묶음이다 */
  to: number;
  infos: number[];
}

/**
 * 판정된 카드들 → 자산군별 규율 증거 D.
 *
 * @param cards 시즌 안에서 판정된 카드 (순서 무관 — 보정이 대칭이다)
 * @param mode  보정 방식 (기본 CORRELATION_CORRECTION)
 */
export function aggregateEvidence(
  cards: readonly EvidenceCard[],
  mode: CorrelationCorrection = CORRELATION_CORRECTION,
): Record<AssetClass, number> {
  const out = Object.fromEntries(ASSET_CLASSES.map((a) => [a, 0])) as Record<AssetClass, number>;
  if (mode === 'NONE') {
    for (const c of cards) out[c.assetClass] += c.info;
    return out;
  }
  if (mode === 'OVERLAP') {
    for (let i = 0; i < cards.length; i++) {
      const a = cards[i];
      const lenA = Math.max(1, a.closedAt - a.openedAt);
      let load = 1;
      for (let j = 0; j < cards.length; j++) {
        if (j === i) continue;
        const b = cards[j];
        if (b.assetClass !== a.assetClass || b.direction !== a.direction) continue;
        const overlap = Math.min(a.closedAt, b.closedAt) - Math.max(a.openedAt, b.openedAt);
        if (overlap <= 0) continue;
        // 짧은 쪽으로 나눈다 — 긴 카드 안에 통째로 든 카드는 일생 전체가 겹친 것이다
        load += overlap / Math.min(lenA, Math.max(1, b.closedAt - b.openedAt));
      }
      out[a.assetClass] += a.info / load;
    }
    return out;
  }

  // ── 아래는 시뮬 비교용 옛 경로 (묶음) — 연쇄 결함이 있다, 파일 상단 주석 참조 ──
  const sorted = [...cards].sort((a, b) => a.openedAt - b.openedAt || a.closedAt - b.closedAt);
  const open: Cluster[] = [];
  for (const card of sorted) {
    const key = `${card.assetClass}|${card.direction}`;
    const found = open.find((c) => c.key === key && card.openedAt < c.to);
    if (found) {
      found.infos.push(card.info);
      found.to = Math.max(found.to, card.closedAt);
    } else {
      open.push({ key, to: card.closedAt, infos: [card.info] });
    }
  }

  for (const c of open) {
    const assetClass = c.key.split('|')[0] as AssetClass;
    out[assetClass] +=
      mode === 'FIRST' ? c.infos[0] : c.infos.reduce((a, b) => a + b, 0) / c.infos.length;
  }
  return out;
}
