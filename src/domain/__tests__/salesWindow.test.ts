import { describe, expect, it } from 'vitest';
import {
  ADVERSE_CLOSE_FRACTION,
  adverseMoveFraction,
  closesOnAdverseMove,
  isSalesWindowOpen,
  NOTICE_EXCESS_Q,
  NOTICE_SHORTFALL_Q,
  remainingFraction,
  remainingReturnPct,
  salesNoticeState,
  salesWindowEnd,
  SUSPEND_ALPHA,
  suspendsPurchase,
} from '../salesWindow';

// 판매 규칙 — 소비자에게 한 약속("결제 승인 = 광고 폭의 절반 이상 보장")이
// 수식과 일치하는지 고정한다. 상수 근거: scripts/simSalesBand.ts (2026-08-10).

describe('remainingReturnPct — 방향 분기 없이 부호가 맞는다', () => {
  it('상승: (목표 − 현재)/현재', () => {
    expect(remainingReturnPct('UP', 100, 110)).toBeCloseTo(10);
    expect(remainingReturnPct('UP', 105, 110)).toBeCloseTo(4.7619, 3);
  });

  it('하락: 목표를 지나쳤으면 음수', () => {
    expect(remainingReturnPct('DOWN', 100, 90)).toBeCloseTo(10);
    expect(remainingReturnPct('DOWN', 85, 90)).toBeCloseTo(-5.882, 2);
  });
});

describe('q = 남은 몫 ÷ 광고 폭', () => {
  it('게시 직후는 1 부근, 절반 왔으면 ~0.5', () => {
    // 기준 100 → 목표 110 (광고 +10%)
    expect(remainingFraction('UP', 100, 110, 10)).toBeCloseTo(1);
    expect(remainingFraction('UP', 105, 110, 10)).toBeCloseTo(0.476, 2);
  });

  it('반대로 빠지면 1보다 커진다 — 분모·분자 양쪽에서 부풀어 2를 쉽게 넘는다', () => {
    expect(remainingFraction('UP', 91, 110, 10)).toBeGreaterThan(2);
  });

  it('장중에 목표를 지나쳤으면 음수', () => {
    expect(remainingFraction('UP', 112, 110, 10)).toBeLessThan(0);
  });
});

describe('판매 중단 (가역) — q < 1/2', () => {
  it('절반 이상 남았으면 판다', () => {
    expect(suspendsPurchase(1)).toBe(false);
    expect(suspendsPurchase(SUSPEND_ALPHA)).toBe(false); // 경계는 판매 쪽
  });

  it('절반 밑이면 막는다 — 목표를 지나친 상태(음수)도 당연히 막힌다', () => {
    expect(suspendsPurchase(SUSPEND_ALPHA - 0.001)).toBe(true);
    expect(suspendsPurchase(-0.5)).toBe(true);
  });
});

describe('괴리 고지 — 문턱이 비대칭인 것이 설계다', () => {
  // 초과 상태는 대칭 문턱(0.2)이면 판매일의 37~50%를 차지해 "고지"가 기본 상태가 된다.
  // 부족은 0.8 밑, 초과는 2.0 위 — 초과 고지는 "반대로 광고 폭 이상 벌어졌다"는 경고다
  it('부족: 광고 폭의 8할 밑', () => {
    expect(salesNoticeState(NOTICE_SHORTFALL_Q - 0.01)).toBe('SHORTFALL');
    expect(salesNoticeState(NOTICE_SHORTFALL_Q)).toBe('NONE');
  });

  it('초과: 반대 방향으로 광고 폭 이상 벌어짐', () => {
    expect(salesNoticeState(NOTICE_EXCESS_Q)).toBe('NONE');
    expect(salesNoticeState(NOTICE_EXCESS_Q + 0.01)).toBe('EXCESS');
  });

  it('그 사이는 고지 없음', () => {
    expect(salesNoticeState(1)).toBe('NONE');
  });
});

// 시간 규칙 — 게시 + min(검증기간 × 1/3, 30일). 유지 확정 (2026-08-10).
describe('salesWindowEnd', () => {
  const published = new Date('2026-07-01T00:00:00Z');

  it('검증 30일 → 판매 10일', () => {
    const end = salesWindowEnd(published, new Date('2026-07-31T00:00:00Z'));
    expect(end.toISOString()).toBe('2026-07-11T00:00:00.000Z');
  });

  it('검증 365일 → 30일 상한이 먼저 걸린다', () => {
    const end = salesWindowEnd(published, new Date('2027-07-01T00:00:00Z'));
    expect(end.getTime() - published.getTime()).toBe(30 * 86_400_000);
  });
});

// 시간 규칙은 저장된 플래그가 아니라 계산이 답한다 — 배치가 늦어도 즉시 닫힌다.
describe('isSalesWindowOpen', () => {
  const published = new Date('2026-07-01T00:00:00Z');
  const deadline = new Date('2026-07-31T00:00:00Z'); // 30일 → 판매 기간 10일
  const end = salesWindowEnd(published, deadline);

  it('마감선 직전은 열려 있다', () => {
    expect(isSalesWindowOpen(published, deadline, new Date(end.getTime() - 1))).toBe(true);
  });

  it('마감선 그 순간부터 닫힌다 — 경계는 닫힘 쪽', () => {
    expect(isSalesWindowOpen(published, deadline, end)).toBe(false);
    expect(isSalesWindowOpen(published, deadline, new Date(end.getTime() + 1))).toBe(false);
  });

  it('게시일이나 시한이 없으면 판단하지 않는다 — 막는 쪽으로 지어내지 않는다', () => {
    expect(isSalesWindowOpen(null, deadline, new Date('2030-01-01'))).toBe(true);
    expect(isSalesWindowOpen(published, null, new Date('2030-01-01'))).toBe(true);
  });
});

// ── 역방향 마감 (2026-08-12) ─────────────────────────────────────────
// 목표 폭만큼 반대로 가면 판매가 **영구히** 닫힌다. 가격 규칙 중 유일한 불가역 처분이라
// 문턱과 방향 부호를 테스트로 못 박는다.

describe('adverseMoveFraction — 예측과 반대로 간 거리 ÷ 광고 폭', () => {
  it('상승 카드: 기준가 아래로 내려간 만큼이 양수', () => {
    // 기준 100, 광고 +30% → 70원이면 −30%, 즉 광고 폭의 100%를 반대로 갔다
    expect(adverseMoveFraction('UP', 100, 70, 30)).toBeCloseTo(1, 10);
    expect(adverseMoveFraction('UP', 100, 85, 30)).toBeCloseTo(0.5, 10);
  });

  it('하락 카드: 기준가 위로 올라간 만큼이 양수 (부호가 저절로 뒤집힌다)', () => {
    expect(adverseMoveFraction('DOWN', 100, 130, 30)).toBeCloseTo(1, 10);
    expect(adverseMoveFraction('DOWN', 100, 70, 30)).toBeCloseTo(-1, 10);
  });

  it('정방향으로 가는 중이면 음수 — 마감 판정에 걸리지 않는다', () => {
    expect(closesOnAdverseMove(adverseMoveFraction('UP', 100, 120, 30))).toBe(false);
  });
});

describe('closesOnAdverseMove — 목표 폭 100% 반대가 문턱', () => {
  it('문턱에 닿으면 마감, 그 앞은 아니다', () => {
    expect(closesOnAdverseMove(ADVERSE_CLOSE_FRACTION)).toBe(true);
    expect(closesOnAdverseMove(ADVERSE_CLOSE_FRACTION - 1e-9)).toBe(false);
    expect(closesOnAdverseMove(1.5)).toBe(true);
  });

  it('초과 고지(q > 2.0)는 마감 직전 구간에서 먼저 뜬다 — 경고 없이 닫히지 않는다', () => {
    // 기준 100, 광고 +10%(목표 110). 마감선은 90원
    const atClose = 90;
    const beforeClose = 91; // 아직 마감선(90) 앞 — 역방향 90%
    expect(closesOnAdverseMove(adverseMoveFraction('UP', 100, atClose, 10))).toBe(true);
    expect(closesOnAdverseMove(adverseMoveFraction('UP', 100, beforeClose, 10))).toBe(false);
    // 마감 전에 이미 초과 고지 상태여야 한다
    expect(salesNoticeState(remainingFraction('UP', beforeClose, 110, 10))).toBe('EXCESS');
  });
});
