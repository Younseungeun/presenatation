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
}

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

  return {
    sampleSize,
    hitRate,
    recentHitRate,
    verifying: sampleSize < MIN_SAMPLE_FOR_VERIFIED,
    hypotheticalReturnPct,
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
