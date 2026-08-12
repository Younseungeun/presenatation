import type { TargetType } from './constants';

// 액면분할·병합·무상증자 대응 — **가격 눈금이 바뀐 것을 알아채고 카드를 그 배수로 고친다.**
//
// 문제: 기준가·목표가는 게시 순간의 원주가로 카드에 박히는데, 시세 공급자의 일봉은
// **수정주가**라 권리 사건이 나면 과거까지 소급해 다시 계산된다. 그러면 카드의
// 기준가만 옛 눈금에 남아 판정·역방향 마감이 통째로 어긋난다
// (2:1 분할이면 −50% 폭락으로 읽힌다).
//
// ── 왜 "가격 비교"가 아니라 "앵커"인가 ──────────────────────────────
// 처음에는 기준가와 최근 종가의 비율이 임계를 넘으면 분할로 보려 했는데, 그것은
// 추론이라 부정확하다: 기준가는 장중 실시간가라 같은 날 종가와도 몇 % 어긋나 있고,
// 무상증자 5%(배수 1.05)는 그 잡음에 묻히며, 반대로 진짜 폭락은 분할로 오인된다.
//
// 그래서 **변할 리 없는 값이 변했는지**를 본다. 게시 시점에 그날의 종가를 하나
// 적어 두고(앵커), 나중에 같은 날짜의 종가를 다시 조회한다. 과거의 종가는 권리
// 사건이 있을 때만 바뀌므로:
//   · 사건이 없으면 배수 = 1.0000 (반올림 오차뿐)
//   · 2:1 분할이면 정확히 0.5, 무상증자 5%면 1/1.05
// 임계값을 고를 필요가 없고, 가격이 오르내린 것과 무관하다. 저장 비용은 카드당
// 실수 하나다.

/** 반올림 오차 허용치 — 이보다 작으면 아무 일도 없었던 것으로 본다 */
export const ADJUSTMENT_EPSILON = 0.002;

/**
 * 권리 사건으로 인정하는 최소 배수 차이 — **2%**.
 *
 * 왜 필요한가 (실측 2026-08-12): 미국 수정주가는 **현금배당까지 소급 반영**한다.
 * 같은 날짜의 수정주가와 원주가를 비교하면 KO −0.64%, XOM −0.67%, AAPL −0.18%
 * (4.5개월 누적)로 벌어진다. 반올림 문턱(0.2%)만 두면 배당이 분할로 오인되고,
 * 원주가 교차검증도 같은 이유로 벌어지므로 **검증을 통과해 자동 리베이스된다.**
 * 국내는 현금배당을 수정주가에 넣지 않아(실측 배수 1.00000) 이 문제가 없다.
 *
 * 2%인 근거: 실제 권리 사건 중 가장 작은 축인 5% 무상증자가 배수 0.952,
 * 2:1 분할이 0.5다. 배당 드리프트(≤0.7%)와 그 사이가 넉넉히 벌어진다.
 */
export const CORPORATE_ACTION_MIN = 0.02;

/**
 * 자동 리베이스를 허용하는 배수 범위.
 * 100:1을 넘는 조정은 실제 사건보다 데이터 사고일 가능성이 높다 — 조용히 고치지 않고
 * 사람이 보게 남긴다(운영자 알림). 지어내지 않는다는 이 도메인의 태도와 같다.
 */
export const MIN_FACTOR = 0.01;
export const MAX_FACTOR = 100;

export interface AdjustmentDetection {
  /** 새 눈금 ÷ 옛 눈금. 2:1 분할이면 0.5 */
  factor: number;
  /**
   * drift = 배당 소급 같은 미세 조정. 카드의 조건을 건드리지 않고 **앵커만 갱신**한다
   * (그대로 두면 드리프트가 쌓여 언젠가 권리 사건으로 오탐한다).
   * action = 분할·병합·무상증자. 기준가·목표가를 새 눈금으로 옮긴다.
   */
  kind: 'drift' | 'action';
  /** 자동으로 고쳐도 되는 범위인가 — 아니면 기록만 남기고 사람에게 올린다 */
  applicable: boolean;
}

/**
 * 같은 거래일의 종가가 달라졌는가 → 조정 배수.
 * 변화가 반올림 수준이면 null (사건 없음).
 */
export function detectAdjustment(
  anchorAtPublish: number,
  anchorNow: number,
): AdjustmentDetection | null {
  if (!(anchorAtPublish > 0) || !(anchorNow > 0)) return null;
  const factor = anchorNow / anchorAtPublish;
  const diff = Math.abs(factor - 1);
  if (diff <= ADJUSTMENT_EPSILON) return null;
  if (diff <= CORPORATE_ACTION_MIN) return { factor, kind: 'drift', applicable: true };
  return {
    factor,
    kind: 'action',
    applicable: factor >= MIN_FACTOR && factor <= MAX_FACTOR,
  };
}

export interface RebaseInput {
  basePrice: number;
  targetType: TargetType;
  /** RETURN_PCT면 등락률(%), TARGET_PRICE면 목표가 */
  targetValue: number;
}

/**
 * 카드의 가격 항목을 새 눈금으로 옮긴다.
 *
 * **수익률형은 건드리지 않는다** — "+30%"는 비율이라 눈금이 바뀌어도 그대로 참이다.
 * 목표가형만 가격이라 배수를 곱한다. 이 구분을 놓치면 수익률형 카드의 목표가
 * 반토막 나서 예측이 저절로 쉬워진다.
 */
export function rebase(input: RebaseInput, factor: number): RebaseInput {
  return {
    basePrice: input.basePrice * factor,
    targetType: input.targetType,
    targetValue:
      input.targetType === 'TARGET_PRICE' ? input.targetValue * factor : input.targetValue,
  };
}

/** 사람이 읽는 설명 — 감사 기록·알림에 그대로 들어간다 */
export function describeFactor(factor: number): string {
  if (factor < 1) {
    const ratio = 1 / factor;
    return `주식 수 ${ratio.toFixed(ratio % 1 < 0.01 ? 0 : 2)}배 증가(액면분할·무상증자 등)로 가격 기준이 ${(factor * 100).toFixed(2)}%로 조정`;
  }
  return `주식 수 감소(액면병합 등)로 가격 기준이 ${factor.toFixed(2)}배로 조정`;
}
