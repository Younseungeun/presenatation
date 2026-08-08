import { describe, expect, it } from 'vitest';
import { floatingSlotFor } from '../floatingSlot';

// 하단에 떠 있는 요소는 한 번에 하나만. 규칙이 두 곳에 흩어지면 언젠가 둘 다 뜨거나
// 둘 다 사라지므로, 이 표가 유일한 기준이다.

const BOTH = { hasJudgment: true, canCompose: true };
const ONLY_JUDGMENT = { hasJudgment: true, canCompose: false };
const ONLY_COMPOSE = { hasJudgment: false, canCompose: true };
const NEITHER = { hasJudgment: false, canCompose: false };

describe('둘 다 가능할 때 — 화면이 무엇을 하러 온 곳인가로 정한다', () => {
  it('홈은 검증 팝업이 먼저 (내 것이 어떻게 되고 있나를 보러 온 자리)', () => {
    expect(floatingSlotFor('/', BOTH)).toBe('judgment');
  });

  it('리더보드·랭킹은 글쓰기가 먼저 (남의 것을 보다가 내 것을 내는 자리)', () => {
    expect(floatingSlotFor('/leaderboard', BOTH)).toBe('compose');
    expect(floatingSlotFor('/ranking', BOTH)).toBe('compose');
  });

  it('MY는 글쓰기 — 검증 팝업은 원래 MY에서 뜨지 않는다(목적지가 MY라서)', () => {
    expect(floatingSlotFor('/my', BOTH)).toBe('compose');
    expect(floatingSlotFor('/my/purchases', BOTH)).toBe('compose');
  });
});

describe('한쪽만 가능할 때는 그쪽이 뜬다', () => {
  it('리더보드에서 비리서처면 검증 팝업이 자리를 받는다', () => {
    expect(floatingSlotFor('/leaderboard', ONLY_JUDGMENT)).toBe('judgment');
  });

  it('홈에서 검증 중인 게 없으면 리서처는 글쓰기를 본다', () => {
    expect(floatingSlotFor('/', ONLY_COMPOSE)).toBe('compose');
  });
});

describe('글쓰기는 탭 화면에서만 — 하던 일이 있는 자리에 새 일을 권하지 않는다', () => {
  it('리포트 상세·설정 같은 하위 화면에는 글쓰기가 없다', () => {
    expect(floatingSlotFor('/report/abc', ONLY_COMPOSE)).toBeNull();
    expect(floatingSlotFor('/settings', ONLY_COMPOSE)).toBeNull();
    expect(floatingSlotFor('/r/abc', ONLY_COMPOSE)).toBeNull();
  });

  it('하위 화면에서도 검증 팝업은 계속 따라다닌다 (지금 동작 유지)', () => {
    expect(floatingSlotFor('/report/abc', ONLY_JUDGMENT)).toBe('judgment');
    expect(floatingSlotFor('/cart', BOTH)).toBe('judgment');
  });
});

describe('아무것도 없으면 아무것도 뜨지 않는다', () => {
  it.each(['/', '/leaderboard', '/ranking', '/my', '/report/abc'])('%s', (path) => {
    expect(floatingSlotFor(path, NEITHER)).toBeNull();
  });
});

describe('두 요소가 동시에 뜨는 경우는 없다', () => {
  it('어떤 화면·어떤 조건에서도 결과는 하나뿐', () => {
    const paths = ['/', '/leaderboard', '/ranking', '/my', '/my/x', '/report/a', '/settings'];
    const inputs = [BOTH, ONLY_JUDGMENT, ONLY_COMPOSE, NEITHER];
    for (const p of paths) {
      for (const i of inputs) {
        const slot = floatingSlotFor(p, i);
        expect(['judgment', 'compose', null]).toContain(slot);
        // 없는 자원을 요구하지 않는다
        if (slot === 'judgment') expect(i.hasJudgment).toBe(true);
        if (slot === 'compose') expect(i.canCompose).toBe(true);
      }
    }
  });
});
