import { describe, expect, it } from 'vitest';
import { CONFIDENCE_RANGE } from '@/domain/scoring';
import { assertPurchasable } from '../purchaseService';

// **규율 상한은 신규 게시가 아니라 팔리는 확신에 걸린다.**
//
// 막는 공격(외부 검토 지적, "알박기"): 표적이 증거 D가 문턱(−2.30) 바로 위일 때
// 남은 장기 슬롯에 365일 기한 ★5 카드를 채워 넣는다. 직후 D가 뚫려 신규 게시가
// ★3으로 제한되지만, 이미 나간 ★5 카드는 1년 내내 팔린다 — 처분에 1년짜리 구멍이 뚫린다.
//
// 별점을 소급해서 내리는 방법은 쓰지 않는다: 그 카드는 신고한 확신(c=10)으로
// 채점되고 있으므로 표시만 낮추면 "별점 = 확률 신고"가 깨지고, 이미 산 사람이
// 보는 것도 바뀐다. **가역적 판매 중단**이 맞다.

const published = new Date('2026-07-01T00:00:00Z');
const now = new Date('2026-07-02T00:00:00Z');

function report(confidence: number) {
  return {
    status: 'PUBLISHED',
    priceKrw: 20_000,
    salesClosedAt: null,
    publishedAt: published,
    researcher: { userId: 'researcher-1' },
    predictionCard: {
      deadline: new Date('2027-06-30T00:00:00Z'), // 장기 카드 (약 1년)
      confidence,
      judgment: null,
    },
  };
}

describe('규율 상한이 내려가면 이미 게시된 카드도 팔리지 않는다', () => {
  it('상한 위의 확신은 막는다 — 게시는 이미 끝났어도 판매는 지금 일어난다', () => {
    expect(() => assertPurchasable(report(10), 'buyer-1', now, 6)).toThrow(/확신 상한이 내려가/);
  });

  it('상한 이하면 그대로 팔린다', () => {
    expect(() => assertPurchasable(report(6), 'buyer-1', now, 6)).not.toThrow();
    expect(() => assertPurchasable(report(2), 'buyer-1', now, 6)).not.toThrow();
  });

  it('규율이 없으면(상한 = 최대) 아무것도 막지 않는다', () => {
    expect(() =>
      assertPurchasable(report(10), 'buyer-1', now, CONFIDENCE_RANGE.max),
    ).not.toThrow();
  });

  it('상한을 주지 않으면 검사하지 않는다 — 규율과 무관한 자리를 위한 경로', () => {
    expect(() => assertPurchasable(report(10), 'buyer-1', now)).not.toThrow();
  });

  it('가역이다 — 상한이 풀리면 같은 카드가 다시 팔린다', () => {
    const card = report(10);
    expect(() => assertPurchasable(card, 'buyer-1', now, 4)).toThrow(/확신 상한이 내려가/);
    expect(() => assertPurchasable(card, 'buyer-1', now, 10)).not.toThrow();
  });
});
