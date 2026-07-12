import { describe, expect, it } from 'vitest';
import { parseFscPriceResponse } from '../fscProvider';

function item(basDt: string, clpr: string) {
  return {
    basDt,
    srtnCd: '005930',
    mkp: '100000',
    hipr: '112000',
    lopr: '98000',
    clpr,
    trqu: '12345678',
  };
}

describe('parseFscPriceResponse', () => {
  it('정상 응답을 날짜 오름차순 DailyQuote로 변환', () => {
    const quotes = parseFscPriceResponse({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
        body: { items: { item: [item('20260710', '111000'), item('20260709', '109000')] } },
      },
    });
    expect(quotes).toEqual([
      {
        date: '2026-07-09',
        open: 100000,
        high: 112000,
        low: 98000,
        close: 109000,
        volume: 12345678,
      },
      {
        date: '2026-07-10',
        open: 100000,
        high: 112000,
        low: 98000,
        close: 111000,
        volume: 12345678,
      },
    ]);
  });

  it('단건 응답(item이 배열이 아닌 경우)도 처리', () => {
    const quotes = parseFscPriceResponse({
      response: {
        header: { resultCode: '00' },
        body: { items: { item: item('20260710', '111000') } },
      },
    });
    expect(quotes).toHaveLength(1);
  });

  it('결과 없음(items 비어 있음) → 빈 배열', () => {
    expect(
      parseFscPriceResponse({ response: { header: { resultCode: '00' }, body: { items: {} } } }),
    ).toEqual([]);
  });

  it('오류 코드 응답은 예외', () => {
    expect(() =>
      parseFscPriceResponse({
        response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED' } },
      }),
    ).toThrow(/30/);
  });
});
