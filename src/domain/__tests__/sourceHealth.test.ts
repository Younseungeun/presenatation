import { describe, expect, it } from 'vitest';
import { classifySourceHealth } from '../sourceHealth';

const base = { providerDownCount: 0, emptyRangeBulk: false, hasMore: false, touched: true };

describe('classifySourceHealth — 시세 소스 세 상태', () => {
  it('공급자 응답 없음이면 장애 (지연·정상보다 우선)', () => {
    expect(classifySourceHealth({ ...base, providerDownCount: 3, hasMore: true })).toBe('down');
  });

  it('빈 시세 대량이면 장애', () => {
    expect(classifySourceHealth({ ...base, emptyRangeBulk: true })).toBe('down');
  });

  it('장애는 없고 회차 상한만 걸리면 지연 (소스는 멀쩡)', () => {
    expect(classifySourceHealth({ ...base, hasMore: true })).toBe('slow');
  });

  it('실제로 판정이 돌았고 문제 없으면 정상', () => {
    expect(classifySourceHealth({ ...base, touched: true })).toBe('ok');
  });

  it('이번 회차에 소스와 상호작용이 없으면 null — 기존 상태를 덮지 않는다', () => {
    expect(classifySourceHealth({ ...base, touched: false })).toBeNull();
    // 단 상호작용이 없어도 장애 신호가 있으면 장애로 남긴다
    expect(classifySourceHealth({ ...base, touched: false, providerDownCount: 1 })).toBe('down');
  });
});
