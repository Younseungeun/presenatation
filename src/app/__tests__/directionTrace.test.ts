import { describe, expect, it } from 'vitest';
import type { ProfitabilityLevel } from '@/domain/profitability';
import {
  PATTERN_LABEL,
  patternFor,
  periodBucketOf,
  SELECTED_PATTERN,
  spanOf,
  TRACE_VARIANTS,
  traceLine,
  traceLineJoin,
  tracePoints,
  type PatternKey,
  type PeriodBucket,
} from '../directionTrace';

// 배경 궤적은 장식이 아니라 예측의 세 축을 실제 차트 패턴 어휘로 옮긴 그림이다.
// 눈으로만 확인하면 규칙이 조용히 깨지므로 좌표로 고정한다.

const LEVELS: ProfitabilityLevel[] = [1, 2, 3, 4, 5];
const PERIODS: PeriodBucket[] = [1, 2, 3, 4, 5];
const base = { profitability: 3 as ProfitabilityLevel, period: 3 as PeriodBucket };

/** 25칸 전체를 훑는다 */
function eachCase(fn: (period: PeriodBucket, profitability: ProfitabilityLevel) => void) {
  for (const period of PERIODS) for (const profitability of LEVELS) fn(period, profitability);
}

describe('고른 25장', () => {
  it('기간 5 × 수익성 5 = 25칸이 빠짐없이 채워져 있다', () => {
    let cells = 0;
    eachCase((period, profitability) => {
      expect(PATTERN_LABEL[SELECTED_PATTERN[period][profitability]]).toBeDefined();
      cells++;
    });
    expect(cells).toBe(25);
  });

  it('모든 프로파일이 시작 0에서 목표 1로 끝난다 — 양 끝 낙차가 곧 예측 크기', () => {
    eachCase((period, profitability) => {
      const pts = tracePoints({ up: true, period, profitability });
      expect(Math.abs(pts[0][1] - pts[pts.length - 1][1])).toBeCloseTo(spanOf(profitability), 1);
      expect(pts[0][0]).toBe(0);
      expect(pts[pts.length - 1][0]).toBe(100);
    });
  });

  it('기간이 길어질수록 어휘가 단기 세팅에서 완만한 바닥으로 넘어간다', () => {
    const short = new Set(Object.values(SELECTED_PATTERN[1]));
    const long = new Set(Object.values(SELECTED_PATTERN[5]));
    expect(short.has('FLAG')).toBe(true); // 단기 = 깃발·삼각수렴
    expect(short.has('CUP')).toBe(false);
    expect(long.has('CUP')).toBe(true); // 장기 = 컵·헤드앤숄더
    expect(long.has('FLAG')).toBe(false);
  });

  it('패턴마다 상승·하락 이름이 다르다 (같은 모양의 상하 대칭)', () => {
    for (const key of Object.keys(PATTERN_LABEL) as PatternKey[]) {
      expect(PATTERN_LABEL[key].up).not.toBe(PATTERN_LABEL[key].down);
    }
    expect(PATTERN_LABEL.DOUBLE.up).toBe('더블 바텀');
    expect(PATTERN_LABEL.DOUBLE.down).toBe('더블 탑');
  });
});

describe('그림은 카드가 아니라 데이터가 정한다', () => {
  it('기간·수익성이 같으면 어느 카드든 같은 그림 (SSR 하이드레이션 불일치 방지)', () => {
    const input = { ...base, up: true };
    expect(traceLine(input)).toBe(traceLine({ ...input }));
  });

  it('배정된 패턴은 고른 25장 안에서만 나온다', () => {
    eachCase((period, profitability) => {
      expect(patternFor(period, profitability)).toBe(SELECTED_PATTERN[period][profitability]);
    });
  });

  it('수익성을 모르면 소폭(1구간) 그림으로 떨어진다', () => {
    for (const period of PERIODS) {
      expect(patternFor(period, null)).toBe(SELECTED_PATTERN[period][1]);
    }
  });

  it('형태의 총 개수 = 고른 25장 × 방향 2 = 50가지', () => {
    const shapes = new Set<string>();
    for (const up of [true, false]) {
      eachCase((period, profitability) => {
        shapes.add(traceLine({ up, period, profitability }));
      });
    }
    // 25칸이 서로 다른 그림이어야 개수 공식이 성립한다
    expect(shapes.size).toBe(TRACE_VARIANTS);
    expect(TRACE_VARIANTS).toBe(50);
  });

  it('같은 패턴이라도 기간이 다르면 다른 그림 — 돌파 구간 길이가 기간을 따른다', () => {
    // 2-1·3-2·4-1처럼 같은 패턴이 여러 기간에 걸쳐 쓰인다
    const byPattern = new Map<PatternKey, Set<string>>();
    eachCase((period, profitability) => {
      const key = SELECTED_PATTERN[period][profitability];
      const set = byPattern.get(key) ?? new Set<string>();
      set.add(traceLine({ up: true, period, profitability }));
      byPattern.set(key, set);
    });
    // 어느 패턴도 두 칸에서 똑같은 그림으로 겹치지 않는다
    let cells = 0;
    for (const set of byPattern.values()) cells += set.size;
    expect(cells).toBe(25);
  });
});

describe('방향 — 위아래 대칭', () => {
  it('상승은 아래에서 시작해 위로 끝난다', () => {
    const pts = tracePoints({ ...base, up: true });
    expect(pts[0][1]).toBeGreaterThan(pts[pts.length - 1][1]); // y는 아래가 큰 좌표계
  });

  it('하락은 위에서 시작해 아래로 끝난다', () => {
    const pts = tracePoints({ ...base, up: false });
    expect(pts[0][1]).toBeLessThan(pts[pts.length - 1][1]);
  });

  it('하락 궤적은 상승 궤적의 정확한 상하 대칭이다 — 그래서 25장만 고르면 된다', () => {
    eachCase((period, profitability) => {
      const u = tracePoints({ up: true, period, profitability });
      const d = tracePoints({ up: false, period, profitability });
      for (let i = 0; i < u.length; i++) {
        expect(d[i][0]).toBe(u[i][0]);
        expect(u[i][1] + d[i][1]).toBeCloseTo(u[0][1] + d[0][1], 1); // 같은 축 기준 반사
      }
    });
  });
});

describe('수익성 — 낙차', () => {
  it('구간이 오를수록 시작·끝의 세로 차이가 커진다', () => {
    for (const period of PERIODS) {
      const spans = LEVELS.map((profitability) => {
        const pts = tracePoints({ up: true, period, profitability });
        return Math.abs(pts[0][1] - pts[pts.length - 1][1]);
      });
      for (let i = 1; i < spans.length; i++) expect(spans[i]).toBeGreaterThan(spans[i - 1]);
      expect(spans[0]).toBeCloseTo(spanOf(1), 1);
      expect(spans[4]).toBeCloseTo(spanOf(5), 1);
    }
  });

  it('낙차는 패턴·기간과 무관하게 수익성만 따른다', () => {
    for (const period of PERIODS) {
      const pts = tracePoints({ up: true, period, profitability: 4 });
      expect(Math.abs(pts[0][1] - pts[pts.length - 1][1])).toBeCloseTo(spanOf(4), 1);
    }
  });

  it('수익성을 모르면 최소 구간으로 그린다', () => {
    const pts = tracePoints({ ...base, up: true, profitability: null });
    expect(Math.abs(pts[0][1] - pts[pts.length - 1][1])).toBeCloseTo(spanOf(1), 1);
  });
});

describe('기간 — 어휘와 꺾임', () => {
  it('검증 기간이 하루·일주일·한달·3달·6달 기준으로 나뉜다', () => {
    expect(periodBucketOf(0.5)).toBe(1);
    expect(periodBucketOf(1)).toBe(1);
    expect(periodBucketOf(2)).toBe(2);
    expect(periodBucketOf(7)).toBe(2);
    expect(periodBucketOf(8)).toBe(3);
    expect(periodBucketOf(30)).toBe(3);
    expect(periodBucketOf(31)).toBe(4);
    expect(periodBucketOf(90)).toBe(4);
    expect(periodBucketOf(91)).toBe(5);
    expect(periodBucketOf(365)).toBe(5);
  });

  it('단기는 뾰족한 꺾임(miter), 중장기는 둥근 꺾임(round)', () => {
    expect(traceLineJoin(1)).toBe('miter');
    expect(traceLineJoin(2)).toBe('miter');
    expect(traceLineJoin(3)).toBe('round');
    expect(traceLineJoin(5)).toBe('round');
  });
});

describe('좌표는 항상 그리기 영역 안에 머문다', () => {
  it('50가지 형태 전부가 viewBox를 벗어나지 않는다', () => {
    for (const up of [true, false]) {
      eachCase((period, profitability) => {
        for (const [x, y] of tracePoints({ up, period, profitability })) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(100);
          expect(y).toBeGreaterThanOrEqual(1.9);
          expect(y).toBeLessThanOrEqual(38.1);
        }
      });
    }
  });
});
