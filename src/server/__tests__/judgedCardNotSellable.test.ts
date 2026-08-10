import { describe, expect, it } from 'vitest';
import { assertPurchasable } from '../purchaseService';

// **판정이 끝난 카드는 팔리면 안 된다.**
//
// 조기 판정이 생기기 전까지 이건 저절로 지켜졌다: 판정은 시한 이후에만 일어나므로
// "시한이 남았다"는 조건이 "아직 판정 전"을 함께 보장했다.
// 조기 판정은 그 전제를 깬다 — 시한이 한참 남았는데 결과가 이미 나온 카드가 생긴다.
// 결과를 아는 사람이 사는 것을 막는 것이 이 서비스의 최소 조건이다.

const deadline = new Date('2026-12-01T00:00:00Z');
const now = new Date('2026-08-10T00:00:00Z'); // 시한 한참 전

function report(judgment: { outcome: string } | null) {
  return {
    status: 'PUBLISHED',
    priceKrw: 20_000,
    salesClosedAt: null,
    publishedAt: new Date('2026-08-01T00:00:00Z'),
    researcher: { userId: 'r1' },
    predictionCard: { deadline, judgment },
  };
}

describe('판정 완료 카드는 구매할 수 없다', () => {
  it('아직 판정 전이면 살 수 있다', () => {
    expect(() => assertPurchasable(report(null), 'buyer', now)).not.toThrow();
  });

  it('조기 판정으로 결과가 나온 카드는 시한이 남아도 막는다', () => {
    expect(() => assertPurchasable(report({ outcome: 'HIT' }), 'buyer', now)).toThrow(
      /판정이 끝난/,
    );
  });
});
