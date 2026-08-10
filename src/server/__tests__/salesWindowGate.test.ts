import { describe, expect, it } from 'vitest';
import { salesWindowEnd } from '@/domain/salesWindow';
import { assertPurchasable } from '../purchaseService';

// 판매 기간(시간 규칙)이 끝난 카드는 **배치를 기다리지 않고** 결제가 막혀야 한다.
//
// 회귀 방지 대상이 명확하다: salesClosedAt은 하루 1회 도는 batch:salesclose가 채우는
// 값이라, 관문이 그 플래그만 보면 마감된 카드가 최대 하루 동안 팔린다. 시간 규칙은
// 게시일·시한만으로 완전히 결정되므로 관문이 직접 계산해야 한다.

const published = new Date('2026-07-01T00:00:00Z');
const deadline = new Date('2026-07-31T00:00:00Z'); // 30일 예측 → 판매 기간 10일
const windowEnd = salesWindowEnd(published, deadline);

function report(overrides: Partial<Parameters<typeof assertPurchasable>[0]> = {}) {
  return {
    status: 'PUBLISHED',
    priceKrw: 20_000,
    salesClosedAt: null,
    publishedAt: published,
    researcher: { userId: 'researcher-1' },
    predictionCard: { deadline },
    ...overrides,
  };
}

describe('판매 기간 종료 후 결제 차단 (배치 지연과 무관)', () => {
  it('판매 기간 안에서는 통과한다', () => {
    expect(() =>
      assertPurchasable(report(), 'buyer-1', new Date(windowEnd.getTime() - 1)),
    ).not.toThrow();
  });

  it('salesClosedAt이 아직 비어 있어도 판매 기간이 끝났으면 막는다', () => {
    expect(() => assertPurchasable(report(), 'buyer-1', windowEnd)).toThrow(/판매 기간이 끝난/);
  });

  it('배치가 열흘 늦어도 그동안 팔리지 않는다', () => {
    const late = new Date(windowEnd.getTime() + 10 * 86_400_000);
    expect(() => assertPurchasable(report(), 'buyer-1', late)).toThrow(/판매 기간이 끝난/);
  });

  it('플래그가 이미 찍혀 있으면 기존 메시지를 그대로 쓴다 — 사유가 둘로 갈리지 않게', () => {
    expect(() =>
      assertPurchasable(
        report({ salesClosedAt: new Date('2026-07-05T00:00:00Z') }),
        'buyer-1',
        new Date('2026-07-06T00:00:00Z'),
      ),
    ).toThrow(/판매가 마감된/);
  });

  it('게시일이 없으면 시간 규칙을 적용하지 않는다', () => {
    expect(() =>
      assertPurchasable(report({ publishedAt: null }), 'buyer-1', new Date('2026-07-25T00:00:00Z')),
    ).not.toThrow();
  });
});

// 사유의 우선순위 — 판매 기간은 시한보다 항상 먼저 끝나므로, 시한까지 지난 카드에
// "판매 기간이 끝났다"고 답하면 틀리진 않아도 덜 말한 것이 된다.
describe('차단 사유는 더 구체적인 쪽을 말한다', () => {
  it('시한까지 지났으면 판매 기간이 아니라 시한 경과를 말한다', () => {
    const past = new Date(deadline.getTime() + 86_400_000);
    expect(() => assertPurchasable(report(), 'buyer-1', past)).toThrow(/검증 시한이 지난/);
  });
});
