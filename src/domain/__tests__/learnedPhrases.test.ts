import { describe, expect, it } from 'vitest';
import type { Finding, ScreeningInput } from '../compliance';
import {
  matchLearnedPhrases,
  needsReview,
  normalizePhrase,
  phrasePrecision,
  PHRASE_MIN_LENGTH,
  suggestPhrase,
  validatePhrase,
  type LearnedPhrase,
} from '../learnedPhrases';

// 학습 표현은 운영자의 반려 판단이 다음 리서처의 작성 화면으로 되돌아오는 통로다.
// 검수 커버리지가 운영 중에 늘어나는 유일한 경로이므로, 여기서 오탐이 나면
// 규칙보다 더 빠르게 공급을 갉아먹는다 — 그래서 하한·심각도·정확도를 테스트로 고정한다.

function input(over: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    title: '삼성전자 분석',
    summary: '요약',
    content: '공개 자료 기반 분석입니다.',
    assetClass: 'KR_EQUITY',
    assetName: '삼성전자',
    direction: 'UP',
    ...over,
  };
}

function phrase(text: string, over: Partial<LearnedPhrase> = {}): LearnedPhrase {
  return {
    id: `p-${text}`,
    phrase: text,
    normalized: normalizePhrase(text),
    category: 'UNSUPPORTED_CLAIM',
    note: null,
    ...over,
  };
}

describe('validatePhrase', () => {
  it('짧은 표현은 막는다 — 아무 문장에나 걸리기 때문', () => {
    expect(validatePhrase('상승')).not.toHaveLength(0);
    expect(validatePhrase('반드시 오릅니다')).toHaveLength(0);
  });

  it('길이 판단은 공백·기호를 뺀 기준으로 한다', () => {
    // "반 · 드 · 시" 처럼 벌려 써도 실제 길이는 그대로여야 한다
    const spaced = '반 드 시 오';
    expect(normalizePhrase(spaced).length).toBe(PHRASE_MIN_LENGTH);
    expect(validatePhrase(spaced)).toHaveLength(0);
  });

  it('한 리포트에만 맞는 긴 문장은 막는다 (재사용되지 않음)', () => {
    expect(validatePhrase('가'.repeat(100))).not.toHaveLength(0);
  });
});

describe('matchLearnedPhrases', () => {
  it('등록된 표현이 본문에 있으면 소견을 낸다', () => {
    const findings = matchLearnedPhrases(
      input({ content: '이 종목은 반드시 오릅니다. 근거는 실적입니다.' }),
      [phrase('반드시 오릅니다', { note: '단정 표현' })],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'UNSUPPORTED_CLAIM',
      severity: 'WARN',
      source: 'learned',
      reason: '단정 표현',
    });
    expect(findings[0].quote).toContain('반드시 오릅니다');
  });

  it('글자를 벌려 써도 걸린다 (규칙과 같은 정규화)', () => {
    const findings = matchLearnedPhrases(
      input({ content: '이 종목은 반 드 시 오 릅 니 다.' }),
      [phrase('반드시 오릅니다')],
    );
    expect(findings).toHaveLength(1);
  });

  it('심각도는 항상 WARN — 사람이 등록한 문자열에 즉시 거절 권한을 주지 않는다', () => {
    const findings = matchLearnedPhrases(input({ content: '원금은 반드시 오릅니다' }), [
      phrase('반드시 오릅니다', { category: 'PROFIT_GUARANTEE' }),
    ]);
    expect(findings[0].severity).toBe('WARN');
  });

  it('표현 id를 남긴다 — 표현별 정확도 집계의 열쇠', () => {
    const findings = matchLearnedPhrases(input({ content: '반드시 오릅니다' }), [
      phrase('반드시 오릅니다'),
    ]);
    expect(findings[0].phraseId).toBe('p-반드시 오릅니다');
  });

  it('없으면 아무것도 내지 않는다', () => {
    expect(
      matchLearnedPhrases(input({ content: '실적 추이를 검토했습니다' }), [
        phrase('반드시 오릅니다'),
      ]),
    ).toHaveLength(0);
  });
});

describe('suggestPhrase', () => {
  function finding(quote: string): Finding {
    return { category: 'RUMOR', severity: 'WARN', quote, reason: '', source: 'ai' };
  }

  it('인용문 중 가장 짧은 것을 제안한다 (짧을수록 재사용된다)', () => {
    expect(suggestPhrase([finding('아주 길고 구체적인 문장이 여기에 들어갑니다'), finding('반드시 오릅니다')])).toBe(
      '반드시 오릅니다',
    );
  });

  it('등록 불가능한 인용문만 있으면 빈 값 (운영자가 직접 쓰게)', () => {
    expect(suggestPhrase([finding('상승')])).toBe('');
  });
});

describe('사전 건강도', () => {
  const stat = (matchCount: number, confirmedCount: number) => ({
    id: 'p1',
    phrase: '반드시 오릅니다',
    category: 'UNSUPPORTED_CLAIM' as const,
    matchCount,
    confirmedCount,
    active: true,
  });

  it('걸린 것 중 반려로 확정된 비율이 정확도다', () => {
    expect(phrasePrecision(stat(10, 3))).toBeCloseTo(0.3);
    expect(phrasePrecision(stat(0, 0))).toBeNull();
  });

  it('표본이 적으면 재검토 대상으로 보지 않는다', () => {
    expect(needsReview(stat(2, 0))).toBe(false);
  });

  it('여러 번 걸렸는데 대부분 승인으로 끝나면 재검토 대상', () => {
    expect(needsReview(stat(10, 1))).toBe(true);
    expect(needsReview(stat(10, 9))).toBe(false);
  });

  it('이미 비활성인 표현은 재검토 대상이 아니다', () => {
    expect(needsReview({ ...stat(10, 0), active: false })).toBe(false);
  });
});
