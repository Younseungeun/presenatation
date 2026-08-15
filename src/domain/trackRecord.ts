import {
  MIN_SAMPLE_FOR_RATE,
  MIN_SAMPLE_FOR_VERIFIED,
  type Direction,
  type Outcome,
} from './constants';

// 리서처 트랙레코드 집계 (프로필·리더보드 표시용).
// 난이도 가중치(역컨센서스·고변동성)와 세부 점수 가중치는 영업비밀 유지 대상이라
// 여기서는 공개 지표(적중률·표본수·최근성·가상 수익률)만 계산한다.

export interface JudgedPrediction {
  outcome: Outcome;
  direction: Direction;
  basePrice: number;
  settledPrice?: number;
  judgedAt: Date;
  /**
   * 이 카드에 **실제로 걸린 돈** (판매 대금 합계, 원) — 2026-08-15.
   *
   * 처음에는 `sold: boolean`이었는데 **세탁에 무너진다**(외부 검토 지적):
   * 최저가 1,000원짜리로 올려 지인이 사면 수수료 100원에 "돈이 걸린 예측"이 된다.
   * 건수는 1,000원과 100만원을 구별하지 못하므로 **금액이 눈금이어야 한다.**
   *
   * 없으면(undefined) 0으로 본다 — 옛 호출부가 조용히 "걸린 카드"로 잡히는 것보다
   * **덜 세는 쪽**이 안전하다.
   */
  stakedKrw?: number;
  /**
   * 이 카드를 산 **서로 다른 사람 수**.
   *
   * 금액만으로는 한 사람이 여러 장 사는 것과 여럿이 사는 것이 같아 보인다. 세탁은
   * 대개 **소수의 협력자**가 하므로, 금액과 사람 수를 함께 요구하면 비용이 곱으로 는다.
   */
  buyers?: number;
}

export interface TrackRecord {
  /** 판정 완료(HIT/MISS) 표본 수 — 판정 불가 건 제외 */
  sampleSize: number;
  /** 전체 적중률 (0~1). 표본 0건이면 null */
  hitRate: number | null;
  /** 최근 12개월 적중률 (최근성 가중 표시용) */
  recentHitRate: number | null;
  /** 표본 수 미달 시 "검증 중" 배지 */
  verifying: boolean;
  /** "전부 따라 샀을 때" 균등 비중 가상 포트폴리오 수익률 (%) */
  hypotheticalReturnPct: number | null;
  /**
   * **돈이 걸린 카드만의 표본·적중률** (2026-08-15 — 외부 검토 D-1의 지적을 일반화).
   *
   * ── 왜 나눠야 하는가 ────────────────────────────────────────
   * 검토는 "무료 실적 카드는 틀려도 현실의 타격이 0이라 유료 카드와 같은 눈금에 두면
   * 안 된다"고 했다. 맞는 지적인데, **범위가 틀렸다** — 그 성질은 무료 카드의 것이 아니라
   * **안 팔린 카드**의 것이다. 지금도 아무도 안 산 유료 카드는 환불도, 구매자 항의도,
   * 평판 손상도 **하나도 일어나지 않는다.** 값을 매겨 진열만 해 두면 무료 카드와
   * 경제적으로 완전히 같다.
   *
   * 그래서 이 구멍은 실적 전용 카드가 여는 것이 아니라 **이미 열려 있다.** 가격표가
   * 아니라 **구매 여부**로 갈라야 한다.
   *
   * ── 무엇이 다른가 ──────────────────────────────────────────
   * 팔린 카드가 틀리면 리서처는 대금을 잃고(성과 연동 환불), 구매자에게 기록이 남고,
   * 이의 제기의 대상이 된다. 안 팔린 카드가 틀리면 아무 일도 없다.
   * **구매자가 "이 사람을 믿을까"를 판단할 때 무게가 같을 수 없다.**
   *
   * 전체 적중률을 없애지 않는 이유: 안 팔린 카드도 **예측으로서는 진짜다**(같은 규칙으로
   * 자동 판정되고 점수·규율 래더에 그대로 들어간다). 숨기면 표본이 줄어 신규 리서처가
   * 영원히 "검증 중"에 갇힌다. 나란히 놓는 것이 맞다.
   */
  stakedSampleSize: number;
  stakedHitRate: number | null;
  /** 걸린 돈의 합계 (원) — 표시의 근거이자 세탁 방어의 눈금 */
  stakedAmountKrw: number;
  /** 이 리서처의 카드를 산 **서로 다른 사람 수** (자산군별 집계 안에서) */
  stakedBuyers: number;
  /**
   * **적중률 숫자를 내보내도 되는가** (STAKED_DISPLAY_FLOOR).
   *
   * 표본 수만으로는 못 막는다 — 1,000원 카드 다섯 장이면 표본 5건이 채워지고
   * "돈이 걸린 예측 100%"가 5,000원에 만들어진다. 그래서 **금액과 사람 수**를
   * 함께 요구한다. 못 넘으면 비율 대신 진행도를 적는다(hitRateLabel과 같은 태도).
   */
  stakedQualified: boolean;
}

/**
 * "돈이 걸린 예측" 적중률을 **숫자로** 내보내기 위한 최소 조건 (2026-08-15).
 *
 * ── 왜 금액과 사람 수를 함께 거는가 ─────────────────────────────
 * 구매 여부(boolean)로만 가르면 **최저가 세탁**이 그대로 통한다: 1,000원에 올려
 * 지인이 사면 수수료 100원으로 "돈이 걸린 예측"이 된다. 검토가 정확히 이 지점을 짚었다.
 *
 * 금액만 걸어도 부족하다 — 한 사람이 만원짜리를 열 장 사면 10만원이 채워진다.
 * 사람 수만 걸어도 부족하다 — 1,000원짜리를 다섯 명이 사면 다섯 명이 채워진다.
 * **둘을 곱으로 요구**해야 세탁 비용이 곱으로 는다.
 *
 * ── 값의 근거 ───────────────────────────────────────────────
 * 가격 가이드가 건당 5천~5만원(기획 §3.4)이라 중간값 2만원 기준:
 *  · 금액 10만원 = 카드 5장어치 판매. 최저가(1,000원)로 채우려면 **100건**이 필요하다
 *  · 구매자 3명 = 지인 동원의 현실적 상한 근처. 본인 인증이 실공급자로 바뀌면
 *    이 조건이 부계정으로는 못 채워진다
 * 정직한 리서처에게는 낮은 문턱이다 — 2만원 카드가 다섯 번 팔리고 사는 사람이
 * 셋이면 넘는다. **막으려는 것은 판매가 아니라 "판매의 시늉"이다.**
 */
export const STAKED_DISPLAY_FLOOR = {
  /** 누적 판매 대금 (원) */
  AMOUNT_KRW: 100_000,
  /** 서로 다른 구매자 수 */
  BUYERS: 3,
} as const;

/** 방향 반영 실현 수익률(%): 하락 예측이 맞으면 양수가 되도록 부호를 뒤집는다 */
function realizedReturnPct(p: JudgedPrediction): number | null {
  if (p.settledPrice === undefined || p.basePrice <= 0) return null;
  const raw = ((p.settledPrice - p.basePrice) / p.basePrice) * 100;
  return p.direction === 'UP' ? raw : -raw;
}

export function computeTrackRecord(predictions: JudgedPrediction[], now = new Date()): TrackRecord {
  const judged = predictions.filter((p) => p.outcome === 'HIT' || p.outcome === 'MISS');
  const sampleSize = judged.length;

  const hitRate = sampleSize > 0 ? judged.filter((p) => p.outcome === 'HIT').length / sampleSize : null;

  const yearAgo = new Date(now);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const recent = judged.filter((p) => p.judgedAt >= yearAgo);
  const recentHitRate =
    recent.length > 0 ? recent.filter((p) => p.outcome === 'HIT').length / recent.length : null;

  const returns = judged
    .map(realizedReturnPct)
    .filter((r): r is number => r !== null);
  const hypotheticalReturnPct =
    returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;

  // **돈이 걸린 카드만** 따로 센다 — 안 팔린 카드는 틀려도 현실의 대가가 0이라
  // 구매자가 "이 사람을 믿을까"를 판단할 때 무게가 같을 수 없다 (TrackRecord 주석)
  const staked = judged.filter((p) => (p.stakedKrw ?? 0) > 0);
  const stakedSampleSize = staked.length;
  const stakedHitRate =
    stakedSampleSize > 0
      ? staked.filter((p) => p.outcome === 'HIT').length / stakedSampleSize
      : null;
  const stakedAmountKrw = staked.reduce((acc, p) => acc + (p.stakedKrw ?? 0), 0);
  // 카드별 구매자 수의 최댓값을 쓴다 — 같은 사람이 여러 카드를 산 것을 여러 명으로
  // 부풀리지 않기 위해서다. 합산은 "3명"을 세 카드 × 1명으로 쉽게 만들어 준다
  const stakedBuyers = staked.reduce((acc, p) => Math.max(acc, p.buyers ?? 0), 0);

  return {
    sampleSize,
    hitRate,
    recentHitRate,
    verifying: sampleSize < MIN_SAMPLE_FOR_VERIFIED,
    hypotheticalReturnPct,
    stakedSampleSize,
    stakedHitRate,
    stakedAmountKrw,
    stakedBuyers,
    stakedQualified:
      stakedAmountKrw >= STAKED_DISPLAY_FLOOR.AMOUNT_KRW &&
      stakedBuyers >= STAKED_DISPLAY_FLOOR.BUYERS,
  };
}

/**
 * 적중률을 화면에 적는 **단 하나의 방법** (2026-08-15).
 *
 * 표본이 `MIN_SAMPLE_FOR_RATE` 미만이면 **숫자를 내보내지 않고 진행도를 적는다.**
 * 계정 둘로 반대 방향을 걸어 살려낸 계정의 "적중률 100%"가 스크린샷으로 나가는 것을
 * 막는 것이 목적이고(상수 주석), 표본 병기만으로는 캡처 한 장을 못 막는다.
 *
 * **함수를 하나로 두는 것이 이 방어의 전부다.** 화면마다 `hitRate * 100`을 적으면
 * 여섯 곳 중 한 곳은 반드시 빠지고, 빠진 그 한 곳이 어뷰저가 캡처하는 화면이 된다.
 */
export function hitRateLabel(
  hitRate: number | null,
  sampleSize: number,
  opts: { digits?: number; none?: string } = {},
): string {
  const { digits = 1, none = '판정 전' } = opts;
  if (hitRate === null || sampleSize === 0) return none;
  if (sampleSize < MIN_SAMPLE_FOR_RATE) return `검증 ${sampleSize}/${MIN_SAMPLE_FOR_RATE}건`;
  return `${(hitRate * 100).toFixed(digits)}%`;
}

/** 표본이 차서 적중률 숫자를 보여줘도 되는가 — 표본 수를 따로 적을지 정할 때 쓴다 */
export function showsHitRate(hitRate: number | null, sampleSize: number): boolean {
  return hitRate !== null && sampleSize >= MIN_SAMPLE_FOR_RATE;
}

/**
 * "돈이 걸린 예측"을 화면에 적는 **단 하나의 방법** (hitRateLabel과 짝).
 *
 * 표본(MIN_SAMPLE_FOR_RATE)에 더해 **금액·사람 수 문턱**까지 넘어야 숫자가 나간다.
 * 못 넘으면 왜 못 넘었는지를 적는다 — "검증 중"만 적으면 리서처가 무엇을 더 해야
 * 하는지 알 수 없고, 문턱을 숨기면 세탁자만 시행착오로 알아낸다.
 */
export function stakedHitRateLabel(r: TrackRecord): string {
  if (r.stakedSampleSize === 0) return '—';
  if (r.stakedSampleSize < MIN_SAMPLE_FOR_RATE) {
    return `검증 ${r.stakedSampleSize}/${MIN_SAMPLE_FOR_RATE}건`;
  }
  if (!r.stakedQualified) return '집계 중';
  return `${(r.stakedHitRate! * 100).toFixed(1)}%`;
}
