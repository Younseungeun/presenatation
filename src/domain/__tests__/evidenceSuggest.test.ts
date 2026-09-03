import { describe, expect, it } from 'vitest';
import { EVIDENCE_SUGGEST_LIMIT, rankEvidenceSentences, splitSentences } from '../evidenceSuggest';

// 근거 문장 추천 (12차 C-3) — 추천은 순서일 뿐 선택은 사람. 사전 표현 이름은 결과에 없다.

const content = [
  '삼성전자 하반기 전망.',
  '메모리 업황 회복을 근거로 상승을 봅니다.',
  '자세한 건 노란 앱으로 오시면 알려드립니다!',
  '원 금 보 장 되니 걱정 마세요.',
  '과거 수익률은 미래를 보장하지 않습니다.',
  '짧음',
].join('\n');

describe('splitSentences', () => {
  it('마침표·줄바꿈으로 자르고 짧은 조각·중복은 뺀다', () => {
    const s = splitSentences(content + '\n삼성전자 하반기 전망.');
    expect(s).toHaveLength(5);
    expect(s[0]).toBe('삼성전자 하반기 전망.');
    expect(s).not.toContain('짧음');
  });
});

describe('rankEvidenceSentences', () => {
  it('소견 인용문이 든 문장이 사전 표현만 든 문장보다 앞, 둘 다면 최상위', () => {
    const r = rankEvidenceSentences({
      content,
      phrases: [{ normalized: '노란앱', category: 'SOLICIT_CONTACT' }, { normalized: '원금보장', category: 'PROFIT_GUARANTEE' }],
      quotes: ['…원 금 보 장 되니…'],
    });
    expect(r[0]).toEqual({ sentence: '원 금 보 장 되니 걱정 마세요.', reason: '소견·사전' }); // 3+2
    expect(r[1]).toEqual({ sentence: '자세한 건 노란 앱으로 오시면 알려드립니다!', reason: '사전' }); // 2
    expect(r).toHaveLength(2);
    // 사전 표현 이름은 결과 어디에도 없다
    expect(JSON.stringify(r)).not.toContain('노란앱');
  });

  it('유형을 고르면 그 유형의 사전 표현만 본다', () => {
    const r = rankEvidenceSentences({
      content,
      phrases: [{ normalized: '노란앱', category: 'SOLICIT_CONTACT' }, { normalized: '원금보장', category: 'PROFIT_GUARANTEE' }],
      quotes: [],
      categories: ['PROFIT_GUARANTEE'],
    });
    expect(r.map((x) => x.sentence)).toEqual(['원 금 보 장 되니 걱정 마세요.']);
  });

  it('띄운 우회("원 금 보 장")도 규칙 엔진과 같은 정규화로 잡힌다', () => {
    const r = rankEvidenceSentences({ content, phrases: [{ normalized: '원금보장', category: 'X' }], quotes: [] });
    expect(r[0].sentence).toContain('원 금 보 장');
  });

  it('상한을 지킨다 — 추천은 목록이 아니다', () => {
    const many = Array.from({ length: 12 }, (_, i) => `문장 ${i} 에는 원금 보장 이 있습니다.`).join('\n');
    const r = rankEvidenceSentences({ content: many, phrases: [{ normalized: '원금보장', category: 'X' }], quotes: [] });
    expect(r).toHaveLength(EVIDENCE_SUGGEST_LIMIT);
  });

  it('아무 근거도 없으면 빈 목록 — 억지로 채우지 않는다', () => {
    expect(rankEvidenceSentences({ content, phrases: [], quotes: [] })).toEqual([]);
  });
});
