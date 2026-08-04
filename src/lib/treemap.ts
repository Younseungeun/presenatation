// 트리맵 레이아웃(squarified treemap) — 값에 비례하는 면적의 사각형들로 영역을 채운다.
// 예측 히트맵에서 "활성 예측이 많은 종목일수록 큰 타일"을 만들 때 쓴다.
// 알고리즘: Bruls, Huizing, van Wijk — "Squarified Treemaps" (타일을 정사각형에 가깝게 유지).

export interface TreemapInput<T> {
  item: T;
  /** 면적 가중치 — 0 이하는 걸러진다 */
  value: number;
}

export interface TreemapRect<T> {
  item: T;
  /** 부모 컨테이너 대비 % 좌표 (absolute 배치용) */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 현재 행(row)을 주어진 변 길이(side)로 깔았을 때 최악 종횡비 — 작을수록 정사각형에 가깝다 */
function worstAspect(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/**
 * 값 내림차순으로 정렬해 100×100 좌표계(%)에 배치한다.
 * aspect = 실제 컨테이너의 가로/세로 비 — 이 비율의 좌표계에서 종횡비를 계산해야
 * 화면에서 타일이 정사각형에 가깝게 나온다 (1이면 정사각형 가정).
 */
export function squarify<T>(inputs: TreemapInput<T>[], aspect = 1): TreemapRect<T>[] {
  const items = inputs.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  if (items.length === 0) return [];

  const total = items.reduce((a, i) => a + i.value, 0);
  // 실제 비율의 좌표계(가로 100×aspect, 세로 100)로 정규화 — 마지막에 %로 되돌린다
  const W = 100 * aspect;
  const scaled = items.map((i) => ({ item: i.item, area: (i.value / total) * W * 100 }));

  const rects: TreemapRect<T>[] = [];
  let x = 0;
  let y = 0;
  let w = W;
  let h = 100;
  let row: { item: T; area: number }[] = [];

  const layoutRow = () => {
    const rowArea = row.reduce((a, r) => a + r.area, 0);
    const horizontal = w >= h; // 넓은 쪽을 따라 행을 깐다
    const side = horizontal ? h : w;
    const thickness = rowArea / side;

    let offset = 0;
    for (const r of row) {
      const length = r.area / thickness;
      rects.push(
        horizontal
          ? { item: r.item, left: x, top: y + offset, width: thickness, height: length }
          : { item: r.item, left: x + offset, top: y, width: length, height: thickness },
      );
      offset += length;
    }
    if (horizontal) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    row = [];
  };

  for (const s of scaled) {
    const side = Math.min(w, h);
    if (row.length === 0) {
      row.push(s);
      continue;
    }
    const current = worstAspect(row.map((r) => r.area), side);
    const withNext = worstAspect([...row.map((r) => r.area), s.area], side);
    if (withNext <= current) {
      row.push(s); // 추가하는 편이 더 정사각형에 가깝다
    } else {
      layoutRow();
      row.push(s);
    }
  }
  if (row.length > 0) layoutRow();

  // 가로축을 %(0~100)로 되돌린다
  return rects.map((r) => ({ ...r, left: r.left / aspect, width: r.width / aspect }));
}
