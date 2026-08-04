import { describe, expect, it } from 'vitest';
import { squarify } from '../treemap';

// 트리맵 불변식: 면적 비례·전체 채움·경계 안·겹침 없음

function area(r: { width: number; height: number }): number {
  return r.width * r.height;
}

describe('squarify', () => {
  it('면적이 값에 비례하고 전체(100×100)를 채운다', () => {
    const rects = squarify([
      { item: 'a', value: 6 },
      { item: 'b', value: 3 },
      { item: 'c', value: 1 },
    ]);
    expect(rects).toHaveLength(3);

    const total = rects.reduce((a, r) => a + area(r), 0);
    expect(total).toBeCloseTo(100 * 100, 5);

    const byItem = Object.fromEntries(rects.map((r) => [r.item, area(r)]));
    expect(byItem.a / byItem.b).toBeCloseTo(2, 5);
    expect(byItem.b / byItem.c).toBeCloseTo(3, 5);
  });

  it('모든 사각형이 경계(0~100) 안에 있다', () => {
    const rects = squarify(
      Array.from({ length: 9 }, (_, i) => ({ item: i, value: i + 1 })),
    );
    for (const r of rects) {
      expect(r.left).toBeGreaterThanOrEqual(-1e-9);
      expect(r.top).toBeGreaterThanOrEqual(-1e-9);
      expect(r.left + r.width).toBeLessThanOrEqual(100 + 1e-9);
      expect(r.top + r.height).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it('사각형끼리 겹치지 않는다 (면적 합 = 전체로 간접 확인 + 쌍별 검사)', () => {
    const rects = squarify(
      Array.from({ length: 6 }, (_, i) => ({ item: i, value: (i + 1) * 2 })),
    );
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapW = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
        const overlapH = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
        const overlap = Math.max(0, overlapW) * Math.max(0, overlapH);
        expect(overlap).toBeLessThan(1e-6);
      }
    }
  });

  it('0 이하 값은 걸러지고, 1개짜리는 전체를 차지한다', () => {
    const rects = squarify([
      { item: 'only', value: 5 },
      { item: 'zero', value: 0 },
      { item: 'neg', value: -2 },
    ]);
    expect(rects).toHaveLength(1);
    expect(area(rects[0])).toBeCloseTo(100 * 100, 5);
  });

  it('빈 입력은 빈 배열', () => {
    expect(squarify([])).toEqual([]);
  });

  it('종횡비를 주면 실제 화면 기준으로 정사각형에 가깝게 나눈다', () => {
    // 가로로 넓은(4:1) 컨테이너에 같은 값 2개 → 위아래가 아니라 좌우로 나뉘어야 한다
    const wide = squarify(
      [
        { item: 'a', value: 1 },
        { item: 'b', value: 1 },
      ],
      4,
    );
    for (const r of wide) {
      expect(r.width).toBeCloseTo(50, 5);
      expect(r.height).toBeCloseTo(100, 5);
    }

    // 세로로 긴(1:4) 컨테이너 → 좌우가 아니라 위아래로 나뉜다
    const tall = squarify(
      [
        { item: 'a', value: 1 },
        { item: 'b', value: 1 },
      ],
      0.25,
    );
    for (const r of tall) {
      expect(r.width).toBeCloseTo(100, 5);
      expect(r.height).toBeCloseTo(50, 5);
    }

    // 불변식 유지: 면적 합 = 100×100(%), 경계 안
    const rects = squarify(
      Array.from({ length: 7 }, (_, i) => ({ item: i, value: i + 1 })),
      1.7,
    );
    const total = rects.reduce((a, r) => a + area(r), 0);
    expect(total).toBeCloseTo(100 * 100, 5);
    for (const r of rects) {
      expect(r.left + r.width).toBeLessThanOrEqual(100 + 1e-9);
      expect(r.top + r.height).toBeLessThanOrEqual(100 + 1e-9);
    }
  });
});
