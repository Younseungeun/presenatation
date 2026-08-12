import type { Direction } from './constants';

// 구매한 카드의 진행 상황 — 순수 계산.
//
// 축이 둘이다: **시간**(게시 → 시한)과 **가격**(기준가 → 목표가).
// 화면은 둘을 **다른 물건으로 그린다** (2026-08-10 개편):
// 막대는 가격 진행만 채우고, 시간은 카드 우측 상단의 4칸 눈금(timeGaugeStep)이 센다.
// 한 막대에 채움(가격)과 마커(시간)를 겹쳤을 때는 둘이 같은 축의 두 값처럼 읽혀
// "이 막대는 무엇의 진행인가"가 매번 다시 해석되어야 했다.
//
// 이 값들은 **판정이 아니다**. 판정은 시한 도래 시점의 확정 시세로만 이뤄지므로,
// 여기 100%가 떠도 시한 전 되돌림이면 실패로 판정된다. 화면이 그 사실을 함께 적어야 한다.

export interface CardProgressInput {
  /** 기준가 — 소급 확정 대기 카드는 null */
  basePrice: number | null;
  /** 조회 시점 시세 — 공급자가 없거나 실패하면 null */
  currentPrice: number | null;
  /** 목표가 (수익률형은 환산값) */
  targetPrice: number | null;
  direction: Direction;
  publishedAt: Date | null;
  deadline: Date;
  now: Date;
}

export interface CardProgress {
  /** 시간 진행 0~1 (게시 → 시한). 게시일을 모르면 시한 30일 전을 출발점으로 본다 */
  timeRatio: number;
  /**
   * 목표 달성률 — 기준가 0, 목표가 1. 시세나 기준가가 없으면 null.
   * 방향 분기가 없다: 하락 카드는 (목표−기준)이 음수라 부호가 저절로 맞는다.
   */
  achievement: number | null;
  /** 기준가 대비 현재 등락(%) — 시세가 없으면 null */
  currentReturnPct: number | null;
  /** 지금 목표에 닿아 있는가 (판정이 아니다 — 시한 전 되돌림이면 실패다) */
  reachedTarget: boolean;
  /** 시한이 지났는데 아직 판정 전 */
  awaitingJudgment: boolean;
}

const DAY_MS = 86_400_000;
/** 게시일을 모르는 카드의 가정 기간 — 시간축이 아예 없는 것보다는 낫다 */
const FALLBACK_HORIZON_MS = 30 * DAY_MS;

export function computeCardProgress(input: CardProgressInput): CardProgress {
  const { basePrice, currentPrice, targetPrice, publishedAt, deadline, now } = input;

  const end = deadline.getTime();
  const start = publishedAt?.getTime() ?? end - FALLBACK_HORIZON_MS;
  const span = end - start;
  const timeRatio =
    span <= 0 ? 1 : Math.min(1, Math.max(0, (now.getTime() - start) / span));

  let achievement: number | null = null;
  let currentReturnPct: number | null = null;
  if (basePrice !== null && basePrice > 0 && currentPrice !== null) {
    currentReturnPct = ((currentPrice - basePrice) / basePrice) * 100;
    if (targetPrice !== null && targetPrice !== basePrice) {
      achievement = (currentPrice - basePrice) / (targetPrice - basePrice);
    }
  }

  return {
    timeRatio,
    achievement,
    currentReturnPct,
    reachedTarget: achievement !== null && achievement >= 1,
    awaitingJudgment: now.getTime() >= end,
  };
}

/** 정방향 막대 채움 폭(%) — 목표 쪽으로 간 거리. 역방향(음수)은 여기서 0이다 */
export function fillPercent(achievement: number | null): number {
  if (achievement === null) return 0;
  return Math.min(100, Math.max(0, achievement * 100));
}

/**
 * 역방향 막대 채움 폭(%) — 예측과 **반대로** 간 거리.
 *
 * 예전에는 역방향이면 막대를 아예 그리지 않았는데, 그러면 "아직 아무 일도 없다"와
 * "크게 어긋나는 중"이 똑같이 빈 막대로 보였다. 나쁜 소식일수록 보이지 않는 화면이
 * 되는 셈이라, 같은 궤도를 반대 색(붉은색)으로 채운다.
 *
 * 눈금이 100%가 되는 지점 = 기준가에서 목표 폭만큼 반대로 간 지점이고,
 * 그 지점이 곧 **판매 영구 마감선**이다 (domain/salesWindow.adverseMoveFraction).
 * 화면의 막대 끝과 규칙의 문턱이 같은 곳에 있어야 막대를 설명 없이 읽을 수 있다.
 */
export function adverseFillPercent(achievement: number | null): number {
  if (achievement === null || achievement >= 0) return 0;
  return Math.min(100, -achievement * 100);
}

/** 시간 눈금 칸 수 — 25%마다 한 칸 */
export const TIME_GAUGE_STEPS = 4;

/**
 * 시간 경과 눈금 1~4 — **채워진 칸 수 = 지금 몇 번째 사분면에 있는가.**
 *
 * 내림(floor)이 아니라 올림(ceil)인 이유: 방금 게시된 카드가 0칸이면 눈금이 통째로
 * 비어 고장 난 것처럼 보인다. 올림을 쓰면 1칸(회색 = 아직 초반)에서 시작해
 * 칸 수가 곧 구간 번호가 되므로 "지금 어디쯤"이 개수만으로 읽힌다.
 * 정확한 퍼센트는 눈금이 말할 수 없으므로 라벨(aria-label·title)이 따로 싣는다.
 */
export function timeGaugeStep(timeRatio: number): number {
  const r = Math.min(1, Math.max(0, timeRatio));
  return Math.min(TIME_GAUGE_STEPS, Math.max(1, Math.ceil(r * TIME_GAUGE_STEPS)));
}
