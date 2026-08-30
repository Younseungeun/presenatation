// 시세 소스 헬스 — "이 자산군 소스가 지금 건강한가"를 한 값으로 접는다 (2026-08-29).
//
// 지금까지 시세 실패는 사건별로 흩어져 있었다(P0 공급자 장애·P1 빈 배열·수동 큐·환불…).
// 그래서 운영자가 "소스가 죽은 건지 그냥 붐비는 건지"를 조각을 모아 추론해야 했다.
// 이 파일은 **이미 나오는 에러 신호**를 세 상태로 접는다 — 새로 시세를 부르지 않는다.
//
//   장애(down) — 소스가 안 답하거나(ProviderUnavailable) 대량으로 빈 값(EMPTY_RANGE).
//                기다려도 안 낫는다. 사람이 소스를 봐야 한다
//   지연(slow) — 소스는 멀쩡한데 회차 상한에 걸려 다 못 돌았다(호출 제약). 저절로 따라잡힌다
//   정상(ok)   — 이번 회차에 실제로 판정/조회가 돌았고 위 둘이 없다
//
// 판단은 **한 회차 결과**로 한다 — 개별 카드 몇 개 실패는 시장 고장이 아니라, 소스 전체가
// 죽었을 때만 down이다(providerDown/emptyRangeBulk는 소스 단위 신호).

export type SourceHealth = 'ok' | 'slow' | 'down';

export interface SourceHealthInput {
  /** ProviderUnavailableError 건수(인증 만료·HTTP 오류·타임아웃 = 물어보지도 못함) */
  providerDownCount: number;
  /** 소스가 대량으로 빈 배열을 준 회차인가 (EMPTY_RANGE_RATIO/MIN 충족) */
  emptyRangeBulk: boolean;
  /** 회차 상한에 걸려 이번에 다 못 돌았는가 (용량 지연 — 소스 장애 아님) */
  hasMore: boolean;
  /** 이번 회차에 소스와 실제로 상호작용했는가 (판정·이월·실패 합 > 0) */
  touched: boolean;
}

/**
 * 회차 결과 → 소스 헬스. **null이면 기록하지 않는다**(이번 회차에 소스와 상호작용이 없어
 * 판단할 근거가 없다 — 조용한 날의 'ok'가 직전 'down'을 덮어쓰지 않게 한다).
 */
export function classifySourceHealth(i: SourceHealthInput): SourceHealth | null {
  if (i.providerDownCount > 0 || i.emptyRangeBulk) return 'down';
  if (i.hasMore) return 'slow';
  if (!i.touched) return null;
  return 'ok';
}

export const SOURCE_HEALTH_LABEL: Record<SourceHealth, string> = {
  ok: '정상',
  slow: '시세 지연',
  down: '시세 장애',
};

// ── 지연 지속 알람 (B) — 순수 판정 ──────────────────────────
//
// 장중 감시 지연(slow)이 얼마나 오래 이어졌는지 세고, 문턱을 넘으면 알린다.
// 상태는 자산군별로 하나 저장되고(server), 매 감시 회차가 이 함수로 갱신한다.
//
// **한 번 알리고 끝이 아니다.** slow가 계속되면 문턱마다 다시 알린다(anchor 갱신) —
// 코인처럼 24시간 slow가 이어지는 자산군이 첫 알람 뒤 영영 침묵하지 않게. 반대로
// slow가 풀리면 상태를 지워, 다음 지연은 처음부터 다시 센다.

export interface SlowAlertState {
  /** 이번 지연 구간 시작 (epoch ms) */
  since: number;
  /** 마지막 slow 관측 (epoch ms) — 구간이 끊겼는지 판단 */
  lastSlowAt: number;
  /** 마지막으로 알린 시각 (epoch ms) — 없으면 아직 안 알림 */
  lastAlertAt: number | null;
}

/**
 * 이번 회차 관측(slow 여부)으로 지속 알람 상태를 갱신하고 알릴지 정한다.
 *
 * · slow 아님 → 상태 없앰(구간 종료), 알람 없음
 * · slow인데 직전 slow와의 간격이 gapResetMs 이내 → 같은 구간 이어감
 * · slow인데 오래 끊겼(또는 처음)으면 → 새 구간 시작
 * · (지금 − 마지막 알람 or 구간 시작) ≥ alertAfterMs 면 알린다
 */
export function decideSlowPersistAlert(
  prev: SlowAlertState | null,
  slow: boolean,
  nowMs: number,
  cfg: { alertAfterMs: number; gapResetMs: number },
): { next: SlowAlertState | null; fire: boolean } {
  if (!slow) return { next: null, fire: false };

  const continued = prev !== null && nowMs - prev.lastSlowAt <= cfg.gapResetMs;
  const since = continued ? prev!.since : nowMs;
  const lastAlertAt = continued ? prev!.lastAlertAt : null;

  const anchor = lastAlertAt ?? since;
  const fire = nowMs - anchor >= cfg.alertAfterMs;

  return {
    next: { since, lastSlowAt: nowMs, lastAlertAt: fire ? nowMs : lastAlertAt },
    fire,
  };
}
