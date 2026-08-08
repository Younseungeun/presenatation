import { describe, expect, it } from 'vitest';
import type { RiskCategory } from '../compliance';
import {
  bestMatch,
  cosineSimilarity,
  findSimilarViolations,
  MIN_SENTENCE_LENGTH,
  splitSentences,
  toFindings,
  type IndexedPhrase,
} from '../semanticIndex';

// 의미 검색의 로직 검증.
//
// 여기서 검증하는 것은 **인덱스·임계값·소견 생성**이지 의미 성능이 아니다.
// 벡터를 테스트가 직접 지정해 "어떤 쌍이 가까운가"를 통제한다 — 가짜 모델로 의미
// 유사도를 흉내 내면 통과해도 아무것도 증명하지 못하기 때문.
// 실제 의미 성능은 모델을 꽂고 npm run eval:screening으로 잰다.

const vec = (...xs: number[]) => Float32Array.from(xs);

function entry(id: string, vector: Float32Array, over: Partial<IndexedPhrase> = {}): IndexedPhrase {
  return {
    id,
    phrase: `표현 ${id}`,
    category: 'UNSUPPORTED_CLAIM' as RiskCategory,
    note: null,
    vector,
    ...over,
  };
}

describe('cosineSimilarity', () => {
  it('같은 방향이면 1, 직교면 0', () => {
    expect(cosineSimilarity(vec(1, 0), vec(2, 0))).toBeCloseTo(1);
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0);
  });

  it('영벡터는 0으로 처리한다 (0으로 나누지 않게)', () => {
    expect(cosineSimilarity(vec(0, 0), vec(1, 1))).toBe(0);
  });

  it('차원이 다르면 예외 — 모델이 섞이면 조용히 틀린 답이 나온다', () => {
    // 차원이 우연히 같으면 예외도 안 나므로, 실제 방어는 vectorModel 필터가 한다.
    // 여기서는 최소한의 안전망만 확인한다.
    expect(() => cosineSimilarity(vec(1, 0), vec(1, 0, 0))).toThrow(/차원/);
  });
});

describe('splitSentences', () => {
  it('문장부호와 줄바꿈으로 나눈다', () => {
    expect(splitSentences('첫 번째 문장입니다. 두 번째 문장입니다.\n세 번째 문장입니다.')).toEqual([
      '첫 번째 문장입니다.',
      '두 번째 문장입니다.',
      '세 번째 문장입니다.',
    ]);
  });

  it('짧은 조각은 버린다 — 의미 벡터가 불안정해 아무 데나 가까워진다', () => {
    expect(splitSentences('네. 이것은 충분히 긴 문장입니다.')).toEqual([
      '이것은 충분히 긴 문장입니다.',
    ]);
    expect('네.'.length).toBeLessThan(MIN_SENTENCE_LENGTH);
  });
});

describe('bestMatch', () => {
  const entries = [entry('a', vec(1, 0)), entry('b', vec(0, 1))];

  it('임계값을 넘는 것 중 가장 가까운 하나만 돌려준다', () => {
    // 여러 유형이 동시에 걸리면 리서처가 무엇을 고쳐야 할지 알 수 없다
    const match = bestMatch(vec(1, 0.1), entries, 0.5);
    expect(match?.entry.id).toBe('a');
  });

  it('임계값 미만이면 아무것도 내지 않는다', () => {
    // (1, 0.2) vs (1, 0) → 약 0.98. 임계값을 조금만 올려도 걸러진다
    expect(bestMatch(vec(1, 0.2), entries, 0.99)).toBeNull();
    expect(bestMatch(vec(1, 1), entries, 0.9)).toBeNull();
  });
});

describe('findSimilarViolations', () => {
  it('같은 표현이 여러 문장에 걸리면 가장 가까운 문장만 남긴다', () => {
    const entries = [entry('a', vec(1, 0))];
    const matches = findSimilarViolations(
      ['조금 비슷한 문장입니다.', '아주 비슷한 문장입니다.'],
      [vec(1, 0.5), vec(1, 0.01)],
      entries,
      0.5,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].sentence).toBe('아주 비슷한 문장입니다.');
  });

  it('점수가 높은 순으로 정렬한다', () => {
    const entries = [entry('a', vec(1, 0)), entry('b', vec(0, 1))];
    const matches = findSimilarViolations(
      ['첫 번째 문장입니다.', '두 번째 문장입니다.'],
      [vec(1, 0.3), vec(0, 1)],
      entries,
      0.5,
    );
    expect(matches.map((m) => m.entry.id)).toEqual(['b', 'a']);
  });
});

describe('toFindings', () => {
  it('심각도는 항상 WARN — 임베딩은 부정을 구분하지 못한다', () => {
    // "원금 보장합니다"와 "원금 보장은 못 합니다"의 코사인 유사도는 높다.
    // 그래서 이 단계 결과로 게시를 거절하면 정상 면책 문구가 죽는다.
    const findings = toFindings([
      {
        entry: entry('a', vec(1, 0), { category: 'PROFIT_GUARANTEE' }),
        score: 0.99,
        sentence: '원금 보장은 못 합니다.',
      },
    ]);
    expect(findings[0].severity).toBe('WARN');
    expect(findings[0].source).toBe('semantic');
  });

  it('어느 표현에 걸렸는지 남긴다 — 표현별 정확도 집계에 쓰인다', () => {
    const findings = toFindings([
      { entry: entry('phrase-1', vec(1, 0)), score: 0.9, sentence: '어떤 문장입니다.' },
    ]);
    expect(findings[0].phraseId).toBe('phrase-1');
    expect(findings[0].quote).toBe('어떤 문장입니다.');
  });
});
