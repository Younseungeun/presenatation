import type { ProfitabilityLevel } from '@/domain/profitability';

// 예측 카드 배경 궤적 — 예측의 세 축을 실제 차트 패턴의 어휘로 옮긴다.
//
// 형태의 출처는 기술적 분석의 고전 패턴이다. 계단식 스윙 하나를 늘였다 줄였다 하면
// 모든 카드가 같은 그림이 되는데, 진짜 차트는 컵앤핸들·더블바텀·삼각수렴처럼
// 저마다 알아볼 수 있는 모양을 가진다. 그래서 패턴 라이브러리를 두고,
// **(기간 × 수익성) 25가지 경우마다 쓸 그림을 하나씩 지정**했다 (SELECTED_PATTERN).
// 자동 배정이 아니라 25장을 눈으로 비교해 고른 결과이므로, 바꾸려면 그 표만 고치면 된다.
//
// 상승과 하락은 같은 프로파일의 상하 대칭이다 — 더블탑은 더블바텀을 뒤집은 것이고
// 라운딩 탑은 컵을 뒤집은 것이라, 한 벌의 정의로 양쪽을 모두 그린다.
// 그래서 고를 것은 25장뿐이고, 형태는 25 × 방향 2 = 정확히 50가지가 된다.
//
//   · 방향(2) → 위아래 대칭. 상승은 위로, 하락은 아래로 진행
//   · 수익성(5) → 시작가에서 목표가까지의 세로 낙차 + 어떤 패턴을 쓸지
//     **수익률 원값이 아니라 5구간에 연동** — 원값 비례는 그래프에서 역산돼 마스킹이 뚫린다
//   · 기간(5) → 어떤 패턴을 쓸지 + 돌파 구간의 길이(같은 패턴도 기간이 다르면 다른 그림)
//
// 카드 식별자는 쓰지 않는다 — 같은 (방향·기간·수익성)이면 어느 카드든 같은 그림이다.
// 배경이 데이터의 그림이지 카드의 장식이 아니어야 하고, 덤으로 SSR 하이드레이션도
// 어긋날 여지가 없다.

/** 좌표계: viewBox 100×40 */
export const TRACE_VIEWBOX = { width: 100, height: 40 } as const;
/** 그림이 머무는 세로 범위 (위아래 여백 2씩) */
const BAND = { top: 2, height: 36 } as const;

/** 기간 구간 — 1(가장 단기) ~ 5(가장 장기) */
export type PeriodBucket = 1 | 2 | 3 | 4 | 5;

/**
 * 검증 기간(일) → 기간 구간. 경계는 하루·일주일·한달·3달·6달.
 * 짧은 쪽을 촘촘히 나눈 이유: 초기 유동성이 단기 카드에서 나오고(판정이 빨리 돌아야
 * 트랙레코드가 쌓인다), 6달을 넘기면 리서처의 회전율이 떨어져 수익성이 나빠진다.
 */
export function periodBucketOf(horizonDays: number): PeriodBucket {
  if (horizonDays <= 1) return 1; // 하루
  if (horizonDays <= 7) return 2; // 일주일
  if (horizonDays <= 30) return 3; // 한달
  if (horizonDays <= 90) return 4; // 3달
  return 5; // 6달 이상
}

/** 구간 표시명 — 안내 문구·개발 도구용 */
export const PERIOD_LABEL: Record<PeriodBucket, string> = {
  1: '하루',
  2: '일주일',
  3: '한달',
  4: '3달',
  5: '6달 이상',
};

export type PatternKey =
  | 'FLAG'
  | 'PENNANT'
  | 'TRIANGLE'
  | 'WEDGE'
  | 'DOUBLE'
  | 'TRIPLE'
  | 'HEAD_SHOULDERS'
  | 'CUP'
  | 'ROUNDING'
  | 'V_REVERSAL'
  | 'STAIRCASE'
  | 'CHANNEL';

/**
 * 패턴 프로파일 — [x, v] 정규 좌표.
 * x는 0~1(가로 진행), v는 목표까지의 진척도(0 = 시작가, 1 = 목표가).
 * v가 음수면 목표 반대쪽으로의 되돌림(상승 패턴의 눌림목, 하락 패턴의 반등)이다.
 * 첫 점은 항상 v=0, 마지막 점은 항상 v=1 — 그래야 양 끝 낙차가 정확히 예측 크기가 된다.
 */
const PATTERNS: Record<PatternKey, readonly (readonly [number, number])[]> = {
  // 깃발: 급한 상승(깃대) → 좁은 되돌림 채널 → 재상승. 단기에 가장 흔한 연속형
  FLAG: [
    [0, 0], [0.22, 0.55], [0.3, 0.42], [0.38, 0.5], [0.46, 0.36],
    [0.54, 0.44], [0.62, 0.3], [0.7, 0.4], [1, 1],
  ],
  // 삼각수렴: 저항선은 수평, 저점은 점점 높아지며 폭이 좁아지다 돌파
  TRIANGLE: [
    [0, 0], [0.08, 0.05], [0.2, -0.22], [0.32, 0.05], [0.44, -0.12],
    [0.56, 0.05], [0.66, -0.05], [0.76, 0.06], [1, 1],
  ],
  // 더블 바텀(W) / 뒤집으면 더블 탑(M): 같은 높이의 바닥 두 번 후 넥라인 돌파
  DOUBLE: [
    [0, 0], [0.12, -0.28], [0.22, -0.3], [0.34, -0.08], [0.42, -0.06],
    [0.54, -0.28], [0.64, -0.3], [0.76, -0.05], [0.84, 0.05], [1, 1],
  ],
  // 역헤드앤숄더 / 뒤집으면 헤드앤숄더: 어깨-머리-어깨, 가운데가 가장 깊다
  HEAD_SHOULDERS: [
    [0, 0], [0.1, -0.2], [0.16, -0.18], [0.26, -0.02], [0.36, -0.32],
    [0.44, -0.34], [0.54, -0.02], [0.64, -0.2], [0.7, -0.18], [0.8, 0.06], [1, 1],
  ],
  // 컵앤핸들 / 뒤집으면 라운딩 탑: 완만한 U 바닥 후 작은 손잡이, 그다음 돌파
  CUP: [
    [0, 0], [0.08, -0.12], [0.18, -0.26], [0.3, -0.3], [0.42, -0.26],
    [0.52, -0.12], [0.6, 0], [0.68, -0.1], [0.74, -0.08], [0.82, 0.15], [1, 1],
  ],
  // 페넌트: 깃대 후 대칭으로 좁아지는 삼각 조정, 그리고 돌파
  PENNANT: [
    [0, 0], [0.2, 0.5], [0.28, 0.28], [0.36, 0.46], [0.44, 0.32],
    [0.52, 0.42], [0.58, 0.36], [0.64, 0.4], [1, 1],
  ],
  // 쐐기: 고점·저점이 함께 기울며 좁아지다 반대로 터진다
  WEDGE: [
    [0, 0], [0.1, -0.2], [0.2, -0.06], [0.3, -0.26], [0.4, -0.14],
    [0.5, -0.3], [0.58, -0.22], [0.68, -0.32], [0.76, -0.26], [1, 1],
  ],
  // 삼중 바닥/천장: 같은 높이를 세 번 확인한 뒤 이탈
  TRIPLE: [
    [0, 0], [0.1, -0.26], [0.18, -0.28], [0.28, -0.06], [0.36, -0.04],
    [0.46, -0.26], [0.54, -0.28], [0.64, -0.06], [0.72, -0.04],
    [0.8, -0.26], [0.86, -0.28], [0.94, 0.05], [1, 1],
  ],
  // 라운딩(접시형): 손잡이 없이 완만하게 도는 바닥·천장
  ROUNDING: [
    [0, 0], [0.1, -0.16], [0.22, -0.28], [0.34, -0.32], [0.46, -0.3],
    [0.58, -0.22], [0.7, -0.1], [0.82, 0.06], [1, 1],
  ],
  // V자 반등: 급락 후 되돌림 없이 곧장 회복
  V_REVERSAL: [
    [0, 0], [0.12, -0.18], [0.26, -0.34], [0.34, -0.3], [0.46, -0.1],
    [0.6, 0.16], [0.74, 0.42], [1, 1],
  ],
  // 계단식: 고점·저점을 한 칸씩 높여 가는 추세
  STAIRCASE: [
    [0, 0], [0.14, 0.28], [0.22, 0.16], [0.36, 0.46], [0.44, 0.34],
    [0.58, 0.62], [0.66, 0.52], [0.8, 0.8], [0.88, 0.72], [1, 1],
  ],
  // 채널: 평행한 두 선 사이에서 규칙적으로 오르내린다
  CHANNEL: [
    [0, 0], [0.1, 0.18], [0.2, 0.06], [0.32, 0.3], [0.42, 0.18],
    [0.54, 0.46], [0.64, 0.34], [0.76, 0.62], [0.86, 0.52], [1, 1],
  ],
} as const;

/**
 * 확정된 25장 — [기간][수익성] 한 칸이 그림 하나.
 * 후보 12종을 25가지 경우마다 나란히 놓고 고른 결과다 (2026-08-08 확정).
 * 세로로 읽으면 기간이 길어질수록 어휘가 단기 세팅(깃발·삼각수렴)에서
 * 반전형(더블·헤드앤숄더)을 거쳐 완만한 바닥(컵)으로 넘어간다.
 */
export const SELECTED_PATTERN: Record<
  PeriodBucket,
  Record<ProfitabilityLevel, PatternKey>
> = {
  //          소폭                보통                적극                공격                초공격
  1: { 1: 'FLAG', 2: 'TRIANGLE', 3: 'FLAG', 4: 'TRIANGLE', 5: 'FLAG' },
  2: { 1: 'FLAG', 2: 'TRIANGLE', 3: 'DOUBLE', 4: 'FLAG', 5: 'TRIANGLE' },
  3: { 1: 'DOUBLE', 2: 'TRIANGLE', 3: 'HEAD_SHOULDERS', 4: 'DOUBLE', 5: 'TRIANGLE' },
  4: { 1: 'DOUBLE', 2: 'HEAD_SHOULDERS', 3: 'CUP', 4: 'DOUBLE', 5: 'HEAD_SHOULDERS' },
  5: { 1: 'CUP', 2: 'HEAD_SHOULDERS', 3: 'CUP', 4: 'HEAD_SHOULDERS', 5: 'CUP' },
} as const;

/**
 * 패턴이 차지하는 가로 폭 — 나머지가 돌파 구간(마지막 임펄스)이다.
 * 짧을수록 패턴이 왼쪽으로 몰리고 돌파가 길고 가팔라지며(빠른 돌파),
 * 길수록 패턴이 화면을 채우고 돌파가 완만하다. 일봉의 깃발은 순식간에 터지고
 * 주봉의 컵은 화면 대부분을 차지하는 실제 인상을 옮긴 것이다.
 * 덕분에 같은 패턴이라도 기간이 다르면 다른 그림이 된다.
 */
const PATTERN_WIDTH: Record<PeriodBucket, number> = {
  1: 0.6,
  2: 0.68,
  3: 0.76,
  4: 0.84,
  5: 0.92,
};


/** 패턴 이름 — 방향에 따라 부르는 이름이 다르다 (같은 모양의 상하 대칭) */
export const PATTERN_LABEL: Record<PatternKey, { up: string; down: string }> = {
  FLAG: { up: '상승 깃발', down: '하락 깃발' },
  PENNANT: { up: '상승 페넌트', down: '하락 페넌트' },
  TRIANGLE: { up: '상승 삼각수렴', down: '하락 삼각수렴' },
  WEDGE: { up: '쐐기 돌파', down: '쐐기 이탈' },
  DOUBLE: { up: '더블 바텀', down: '더블 탑' },
  TRIPLE: { up: '삼중 바닥', down: '삼중 천장' },
  HEAD_SHOULDERS: { up: '역헤드앤숄더', down: '헤드앤숄더' },
  CUP: { up: '컵앤핸들', down: '핸들형 천장' },
  ROUNDING: { up: '라운딩 바텀', down: '라운딩 탑' },
  V_REVERSAL: { up: 'V자 반등', down: '역V자 급락' },
  STAIRCASE: { up: '계단식 상승', down: '계단식 하락' },
  CHANNEL: { up: '상승 채널', down: '하락 채널' },
};

/** 후보 전체 — 실제로 쓰이는 것은 SELECTED_PATTERN에 올린 것뿐이다 (선택 도구용) */
export const ALL_PATTERNS = Object.keys(PATTERN_LABEL) as PatternKey[];

/** 카드에 쓰이는 패턴 — 기간·수익성이 정해지면 그림도 정해진다 */
export function patternFor(
  period: PeriodBucket,
  profitability: ProfitabilityLevel | null,
): PatternKey {
  return SELECTED_PATTERN[period][profitability ?? 1];
}

/**
 * 수익성 구간 → 시작가에서 목표가까지의 세로 낙차 (1구간 8 … 5구간 24).
 * 상한이 24인 이유: 패턴의 되돌림이 낙차의 최대 34%까지 밖으로 나가므로,
 * 24 × 1.34 ≈ 32가 그림 영역(36) 안에 들어와야 한다.
 */
export function spanOf(profitability: ProfitabilityLevel | null): number {
  return 4 + (profitability ?? 1) * 4;
}

export interface TraceInput {
  up: boolean;
  profitability: ProfitabilityLevel | null;
  period: PeriodBucket;
}

/**
 * 궤적 꼭짓점.
 * 패턴의 v 범위를 그림 영역 안에 세로 중앙 정렬한다 — 되돌림이 깊은 패턴도
 * 위아래로 잘리지 않고, 양 끝의 낙차는 항상 정확히 예측 크기로 유지된다.
 */
export function tracePoints(input: TraceInput): Array<[number, number]> {
  return patternPoints(
    patternFor(input.period, input.profitability),
    input.period,
    input.up,
    input.profitability,
  );
}

/** 패턴을 직접 지정해 그린다 — 선택 도구·테스트에서 후보를 훑을 때 쓴다 */
export function patternPoints(
  pattern: PatternKey,
  period: PeriodBucket,
  up: boolean,
  profitability: ProfitabilityLevel | null,
): Array<[number, number]> {
  const profile = PATTERNS[pattern];
  const span = spanOf(profitability);

  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [, v] of profile) {
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const used = (vMax - vMin) * span;
  const top = BAND.top + (BAND.height - used) / 2;

  // 마지막 점(목표)은 항상 오른쪽 끝, 패턴 구간은 기간에 따라 압축된다
  const w = PATTERN_WIDTH[period];
  const lastIndex = profile.length - 1;

  return profile.map(([x, v], i) => [
    Number(((i === lastIndex ? 1 : x * w) * TRACE_VIEWBOX.width).toFixed(1)),
    // 상승은 v가 클수록 위(작은 y), 하락은 그 반대
    Number((up ? top + (vMax - v) * span : top + (v - vMin) * span).toFixed(1)),
  ]);
}

/** 선 path (`M… L…`) */
export function traceLine(input: TraceInput): string {
  return `M${tracePoints(input)
    .map(([x, y]) => `${x},${y}`)
    .join(' L')}`;
}

/** 면 path — 선 아래를 바닥까지 닫는다 */
export function traceArea(input: TraceInput): string {
  return `${traceLine(input)} L${TRACE_VIEWBOX.width},${TRACE_VIEWBOX.height} L0,${TRACE_VIEWBOX.height} Z`;
}

/** 단기 패턴은 뾰족한 꺾임, 중장기는 둥근 꺾임 */
export function traceLineJoin(period: PeriodBucket): 'miter' | 'round' {
  return period <= 2 ? 'miter' : 'round';
}

/** 존재하는 형태의 수 — 고른 그림 25장 × 방향 2 = 50가지 */
export const TRACE_VARIANTS =
  2 * Object.values(SELECTED_PATTERN).reduce((n, byLevel) => n + Object.keys(byLevel).length, 0);

/** 패턴 지정 선 path — 선택 도구용 */
export function patternLine(
  pattern: PatternKey,
  period: PeriodBucket,
  up: boolean,
  profitability: ProfitabilityLevel | null,
): string {
  return `M${patternPoints(pattern, period, up, profitability)
    .map(([x, y]) => `${x},${y}`)
    .join(' L')}`;
}
