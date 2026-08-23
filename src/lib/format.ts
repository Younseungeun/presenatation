import { ASSET_CLASS_LABEL, type AssetClass, type Direction, type TargetType } from '@/domain/constants';

// 화면 표시 문자열의 단일 기준.
// 같은 값이 화면마다 다른 문구로 보이면(예: "오늘 마감" vs "오늘 시한") 같은 상태인지
// 사용자가 다시 판단해야 한다. 날짜·D-day·예측 카드 요약은 여기서만 만든다.

const DAY_MS = 86_400_000;

/** 26년 8월 5일 — 목록·메타 줄의 기본 날짜 */
export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('ko-KR', {
    year: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

/** 8월 5일 — 연도가 자명한 운영 화면용 */
export function fmtDayMonth(d: Date | string): string {
  return new Date(d).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

/** 2026년 8월 5일 오전 09:00 — 판정·결제처럼 시각이 근거가 되는 자리 */
export function fmtDateTime(d: Date | string): string {
  return new Date(d).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 시한까지 남은 기간. 지난 시한은 판정 대기 상태다 */
export function dday(deadline: Date | string | null | undefined, now: Date): string {
  if (!deadline) return '—';
  const days = Math.ceil((new Date(deadline).getTime() - now.getTime()) / DAY_MS);
  if (days < 0) return '시한 지남';
  if (days === 0) return '오늘 마감';
  return `D-${days}`;
}

/** 오늘 / 어제 / n일 전 / 8월 5일 — 지나간 일의 거리감 */
export function sinceLabel(d: Date | string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(d).getTime()) / DAY_MS);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return fmtDayMonth(d);
}

/** ▲ 상승 / ▼ 하락 */
export function directionLabel(direction: Direction | string | null | undefined): string {
  if (!direction) return '';
  return direction === 'UP' ? '▲ 상승' : '▼ 하락';
}

/** 12% / 목표가 70,000 — 수익률형과 목표가형은 단위가 다르다 */
export function sizeLabel(
  targetType: TargetType | string | null | undefined,
  targetValue: number | null | undefined,
): string {
  if (targetValue === null || targetValue === undefined) return '';
  return targetType === 'RETURN_PCT' ? `${targetValue}%` : `목표가 ${targetValue.toLocaleString()}`;
}

/** ▲ 상승 12% — 방향과 크기를 붙인 한 덩어리 */
export function predictionLabel(
  direction: Direction | string | null | undefined,
  targetType: TargetType | string | null | undefined,
  targetValue: number | null | undefined,
): string {
  return [directionLabel(direction), sizeLabel(targetType, targetValue)].filter(Boolean).join(' ');
}

export interface CardSummaryInput {
  assetClass: string;
  assetName: string;
  direction: string;
  targetType: string;
  targetValue: number;
}

/** 코인 비트코인 · ▲ 상승 12% — 카드 한 줄 요약 */
export function cardLine(c: CardSummaryInput): string {
  const asset = ASSET_CLASS_LABEL[c.assetClass as AssetClass] ?? c.assetClass;
  return `${asset} ${c.assetName} · ${predictionLabel(c.direction, c.targetType, c.targetValue)}`;
}
