import { MIN_SAMPLE_FOR_VERIFIED, type Direction, type Outcome } from './constants';

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
