import { describe, expect, it } from 'vitest';
import { parseBithumbCandles, toBithumbSymbol } from '../bithumbProvider';

describe('parseBithumbCandles', () => {
  // 빗썸은 **종가가 두 번째 칸**이다 (업비트·KIS와 다르다). 이 순서를 잘못 읽으면
  // 모든 코인 판정이 불일치로 멈추므로 픽스처가 그 사실 자체를 고정한다:
  // [시각, 시가, 종가, 고가, 저가, 거래량]
  const rows = [
    [1_752_105_600_000, '100', '130', '140', '90', '12.5'],
    [1_752_019_200_000, '95', '105', '110', '90', '3.5'],
  ];

  it('종가·고가·저가를 자리로 구분한다 (순서 착오가 조용히 지나가지 않게)', () => {
    const [first] = parseBithumbCandles(rows);
    expect(first.open).toBe(95);
    expect(first.close).toBe(105);
    expect(first.high).toBe(110);
    expect(first.low).toBe(90);
    expect(first.volume).toBe(3.5);
  });

  it('날짜 오름차순으로 정렬한다 (판정 구간 계산이 순서를 전제한다)', () => {
    const parsed = parseBithumbCandles(rows);
    expect(parsed.map((q) => q.date)).toEqual([...parsed.map((q) => q.date)].sort());
  });

  it('종가가 0이거나 숫자가 아닌 줄은 버린다', () => {
    const parsed = parseBithumbCandles([
      [1_752_019_200_000, '95', '0', '110', '90', '3.5'],
      [1_752_105_600_000, '95', 'x', '110', '90', '3.5'],
    ]);
    expect(parsed).toHaveLength(0);
  });
});

describe('toBithumbSymbol', () => {
  it('업비트 마켓코드를 빗썸 심볼로 옮긴다', () => {
    expect(toBithumbSymbol('KRW-BTC')).toBe('BTC_KRW');
    expect(toBithumbSymbol('krw-eth')).toBe('ETH_KRW');
  });

  it('KRW 마켓이 아니면 null — 지어내지 않는다', () => {
    expect(toBithumbSymbol('BTC-ETH')).toBeNull();
    expect(toBithumbSymbol('005930')).toBeNull();
  });
});
