import { beforeEach, describe, expect, it } from 'vitest';
import { CHECKOUT_RULE, hitRateLimit, resetRateLimits } from '../rateLimit';

// **막으려는 것은 부하가 아니라 카드 테스팅이다.**
// 도난 카드 목록을 들고 와서 1초에 수십 번 결제를 시도해 살아 있는 카드를 골라내는 짓.
// 실제 현금이 오가기 시작하면 첫 주에 오고, 당하면 승인 실패율 때문에 PG 가맹점
// 자격 자체가 위험해진다.

const T0 = 1_000_000;

beforeEach(() => resetRateLimits());

describe('결제 관문 호출 제한', () => {
  it('창 안에서 상한까지는 통과, 넘으면 막고 남은 시간을 말한다', () => {
    for (let i = 0; i < CHECKOUT_RULE.limit; i++) {
      expect(hitRateLimit('checkout:user', 'u1', CHECKOUT_RULE, T0).ok).toBe(true);
    }
    const over = hitRateLimit('checkout:user', 'u1', CHECKOUT_RULE, T0);
    expect(over.ok).toBe(false);
    expect(over.retryAfterMs).toBeGreaterThan(0);
  });

  it('창이 지나면 다시 열린다 — 영구 차단이 아니다', () => {
    for (let i = 0; i <= CHECKOUT_RULE.limit; i++) {
      hitRateLimit('checkout:user', 'u2', CHECKOUT_RULE, T0);
    }
    expect(hitRateLimit('checkout:user', 'u2', CHECKOUT_RULE, T0).ok).toBe(false);
    const later = T0 + CHECKOUT_RULE.windowMs + 1;
    expect(hitRateLimit('checkout:user', 'u2', CHECKOUT_RULE, later).ok).toBe(true);
  });

  it('키가 다르면 서로 영향을 주지 않는다 — 한 사람이 남을 막을 수 없다', () => {
    for (let i = 0; i <= CHECKOUT_RULE.limit; i++) {
      hitRateLimit('checkout:user', 'attacker', CHECKOUT_RULE, T0);
    }
    expect(hitRateLimit('checkout:user', 'attacker', CHECKOUT_RULE, T0).ok).toBe(false);
    expect(hitRateLimit('checkout:user', 'innocent', CHECKOUT_RULE, T0).ok).toBe(true);
  });

  // **사용자와 IP를 따로 세는 이유**: 계정 하나로 두드리는 것은 사용자 키가 막지만,
  // 카드 테스팅은 보통 계정을 여러 개 만들어 두드린다 — 그건 IP 키만 잡는다
  it('통(bucket)이 다르면 따로 센다 — 사용자 키와 IP 키가 서로를 소모하지 않는다', () => {
    for (let i = 0; i <= CHECKOUT_RULE.limit; i++) {
      hitRateLimit('checkout:ip', '1.2.3.4', CHECKOUT_RULE, T0);
    }
    expect(hitRateLimit('checkout:ip', '1.2.3.4', CHECKOUT_RULE, T0).ok).toBe(false);
    // 같은 문자열이라도 다른 통이면 처음부터 센다
    expect(hitRateLimit('checkout:user', '1.2.3.4', CHECKOUT_RULE, T0).ok).toBe(true);
  });

  it('정상 구매 흐름은 걸리지 않는다 — 장바구니로 여러 건도 한 번에 나간다', () => {
    // 리포트 하나 사는 데 의도 생성 + 승인 확정 두 번. 1분에 세 건을 사도 6회다
    let blocked = 0;
    for (let purchase = 0; purchase < 3; purchase++) {
      for (const step of ['intent', 'confirm']) {
        if (!hitRateLimit('checkout:user', 'normal', CHECKOUT_RULE, T0).ok) {
          blocked++;
          console.error(`정상 흐름이 막혔다: ${purchase + 1}번째 구매의 ${step}`);
        }
      }
    }
    expect(blocked).toBe(0);
  });
});
