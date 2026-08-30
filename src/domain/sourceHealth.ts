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
