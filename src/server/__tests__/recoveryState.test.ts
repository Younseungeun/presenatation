import { describe, expect, it } from 'vitest';
import { selectProbeTargets } from '../recoveryState';

// **탐침 표적을 티커별로 고르게 뽑는다** (2026-08-15, 외부 검토 E-2).
//
// 전에는 불일치 카드를 나온 순서대로 잘랐다. 배치가 시한 순으로 도니 같은 종목이
// 앞자리를 독차지하기 쉽고, 그러면 12건 중 10건이 A·2건이 B일 때 표적 5장이 전부
// A가 된다. 그 상태로 전원 합의하면 **B 파이프라인이 깨진 채 정지가 풀린다.**
describe('selectProbeTargets', () => {
  const card = (id: string, ticker: string) => ({ id, ticker });

  it('서로 다른 티커를 먼저 채운다 — 한 종목이 표본을 독차지하지 못하게', () => {
    const cards = [
      ...Array.from({ length: 10 }, (_, i) => card(`a${i}`, 'AAA')),
      card('b0', 'BBB'),
      card('b1', 'BBB'),
    ];
    const picked = selectProbeTargets(cards, 5);
    expect(picked).toHaveLength(5);
    // 순서대로 잘랐다면 전부 AAA였다 — 이제 BBB가 반드시 들어간다
    const tickers = picked.map((id) => cards.find((c) => c.id === id)!.ticker);
    expect(tickers).toContain('BBB');
    expect(new Set(tickers).size).toBe(2);
  });

  it('티커가 하나뿐이면 그 티커로 채운다 (억지로 비우지 않는다)', () => {
    const cards = Array.from({ length: 4 }, (_, i) => card(`a${i}`, 'AAA'));
    expect(selectProbeTargets(cards, 5)).toHaveLength(4);
  });

  it('티커가 표본보다 많으면 각 티커에서 한 장씩만', () => {
    const cards = Array.from({ length: 9 }, (_, i) => card(`c${i}`, `T${i}`));
    const picked = selectProbeTargets(cards, 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((id) => cards.find((c) => c.id === id)!.ticker)).size).toBe(5);
  });

  it('빈 입력이면 빈 결과 — 무한 루프에 빠지지 않는다', () => {
    expect(selectProbeTargets([], 5)).toEqual([]);
  });
});
