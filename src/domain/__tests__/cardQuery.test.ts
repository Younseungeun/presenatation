import { describe, expect, it } from 'vitest';
import {
  buildQueryString,
  hasCriteria,
  parseCardQuery,
  TAG_GROUPS,
  tierAtLeast,
  toggleTag,
} from '../cardQuery';

// 검색은 종목이 아니라 **예측의 성질**을 축으로 삼는다.
// 종목으로 좁히면 "이 조건으로 나온 카드 = 그 종목 예측"이 되어 구매 전 마스킹이 뚫린다.

describe('자유 텍스트 = 리서처 이름', () => {
  it('해시태그가 없으면 전부 이름 검색어', () => {
    expect(parseCardQuery('크립토애널리스트').text).toBe('크립토애널리스트');
  });

  it('첫 해시태그 이전까지가 이름이다', () => {
    const q = parseCardQuery('밸류헌터 #국내주식');
    expect(q.text).toBe('밸류헌터');
    expect(q.assetClasses).toEqual(['KR_EQUITY']);
  });

  it('빈 검색어는 조건이 없다', () => {
    expect(hasCriteria(parseCardQuery(''))).toBe(false);
    expect(hasCriteria(parseCardQuery('   '))).toBe(false);
  });
});

describe('사람이 띄어 쓴 조건도 알아듣는다', () => {
  it('"#신뢰도 4이상"처럼 태그 안에 공백이 있어도 한 조건이다', () => {
    // 공백으로 자르면 "#신뢰도"와 "4이상"으로 두 토막 난다 — 그래서 '#'로 자른다
    const q = parseCardQuery('#국내주식 #상승 #수익성 3이상 #신뢰도 4이상');
    expect(q.assetClasses).toEqual(['KR_EQUITY']);
    expect(q.direction).toBe('UP');
    expect(q.minProfitability).toBe(3);
    expect(q.minConfidence).toBe(4);
    expect(q.unknown).toEqual([]);
  });

  it('붙여 써도 같다', () => {
    const q = parseCardQuery('#수익성3이상#신뢰도4이상');
    expect(q.minProfitability).toBe(3);
    expect(q.minConfidence).toBe(4);
  });

  it('안정성도 조건 축이다 — 종목 변동성 기반 시스템 산정으로 돌아왔다 (stability.ts)', () => {
    const q = parseCardQuery('#안정성 3이상');
    expect(q.minStability).toBe(3);
    expect(q.minConfidence).toBeNull();
    expect(q.unknown).toEqual([]);
  });

  it('"이상" 없이 숫자만 써도 하한으로 읽는다', () => {
    expect(parseCardQuery('#수익성4').minProfitability).toBe(4);
    expect(parseCardQuery('#신뢰도 3점이상').minConfidence).toBe(3);
  });
});

describe('자산군·방향', () => {
  it('여러 자산군을 겹쳐 쓸 수 있다', () => {
    expect(parseCardQuery('#국내주식 #코인').assetClasses).toEqual(['KR_EQUITY', 'CRYPTO']);
  });

  it('같은 자산군을 두 번 써도 한 번만 담긴다', () => {
    expect(parseCardQuery('#코인 #암호화폐').assetClasses).toEqual(['CRYPTO']);
  });

  it('방향은 동의어를 받는다 (마지막 것이 이긴다 — 상승이면서 하락일 수는 없다)', () => {
    expect(parseCardQuery('#롱').direction).toBe('UP');
    expect(parseCardQuery('#숏').direction).toBe('DOWN');
    expect(parseCardQuery('#상승 #하락').direction).toBe('DOWN');
  });
});

describe('거래 조건', () => {
  it('무위험 = 선결제 0%', () => {
    expect(parseCardQuery('#무위험').refundOnly).toBe(true);
    expect(parseCardQuery('#전액환불').refundOnly).toBe(true);
  });

  it('예산은 만원 단위와 원 단위를 모두 받는다', () => {
    expect(parseCardQuery('#1만원이하').maxPriceKrw).toBe(10_000);
    expect(parseCardQuery('#3만원이하').maxPriceKrw).toBe(30_000);
    expect(parseCardQuery('#9900원이하').maxPriceKrw).toBe(9_900);
  });

  it('시한은 말로도 숫자로도 쓴다', () => {
    expect(parseCardQuery('#일주일내').withinDays).toBe(7);
    expect(parseCardQuery('#한달내').withinDays).toBe(30);
    expect(parseCardQuery('#오늘마감').withinDays).toBe(1);
    expect(parseCardQuery('#14일내').withinDays).toBe(14);
  });
});

describe('리서처 조건', () => {
  it('등급은 "이상"을 붙이든 말든 하한으로 읽는다 — 등급은 원래 서열이다', () => {
    expect(parseCardQuery('#마스터이상').minTier).toBe('GOLD');
    expect(parseCardQuery('#마스터').minTier).toBe('GOLD');
    expect(parseCardQuery('#펠로우').minTier).toBe('PLATINUM');
  });

  it('인증 배지 / 신규 리서처를 따로 찾을 수 있다', () => {
    expect(parseCardQuery('#인증').verifiedOnly).toBe(true);
    // 신규를 일부러 찾는 길 — 이들은 선결제가 막혀 있어 언제나 전액 환불이다
    expect(parseCardQuery('#신규').newcomerOnly).toBe(true);
    expect(parseCardQuery('#판정전').newcomerOnly).toBe(true);
  });
});

describe('못 알아들은 태그는 삼키지 않는다', () => {
  it('모르는 태그를 unknown에 남긴다 — 조용히 무시하면 결과가 왜 이런지 알 수 없다', () => {
    const q = parseCardQuery('#삼성전자 #상승');
    expect(q.unknown).toEqual(['삼성전자']);
    expect(q.direction).toBe('UP');
  });

  it('종목명은 조건이 되지 않는다 (구매 전 마스킹이 뚫리면 안 된다)', () => {
    const q = parseCardQuery('#비트코인');
    expect(q.unknown).toEqual(['비트코인']);
    expect(hasCriteria(q)).toBe(false);
  });

  it('빈 태그는 조용히 무시한다', () => {
    expect(parseCardQuery('# #상승').unknown).toEqual([]);
  });
});

describe('제안하는 태그와 알아듣는 태그는 갈라지면 안 된다', () => {
  it('TAG_GROUPS의 모든 태그를 파서가 해석한다 (하나라도 unknown이면 "눌렀는데 안 먹는 태그")', () => {
    for (const group of TAG_GROUPS) {
      for (const { tag } of group.tags) {
        const q = parseCardQuery(tag);
        expect(q.unknown, `${tag} 를 파서가 못 알아들음`).toEqual([]);
        expect(hasCriteria(q), `${tag} 가 조건을 만들지 못함`).toBe(true);
      }
    }
  });

  it('태그가 중복되지 않는다', () => {
    const all = TAG_GROUPS.flatMap((g) => g.tags.map((t) => t.tag));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('태그 선택 — 겹칠 수 없는 조건이 함께 걸리지 않게', () => {
  it('같은 단일 축은 대체한다 (상승이면서 하락일 수는 없다)', () => {
    expect(toggleTag(['#상승'], '#하락')).toEqual(['#하락']);
    expect(toggleTag(['#신뢰도 3이상'], '#신뢰도 4이상')).toEqual(['#신뢰도 4이상']);
  });

  it('다중 축(자산군)은 겹쳐 쌓인다', () => {
    expect(toggleTag(['#국내주식'], '#코인')).toEqual(['#국내주식', '#코인']);
  });

  it('같은 태그를 다시 누르면 해제된다', () => {
    expect(toggleTag(['#상승', '#무위험'], '#상승')).toEqual(['#무위험']);
  });

  it('다른 축은 서로 건드리지 않는다', () => {
    const picked = toggleTag(toggleTag(['#상승'], '#무위험'), '#1만원이하');
    expect(picked).toEqual(['#상승', '#무위험', '#1만원이하']);
  });

  it('선택한 태그와 이름을 한 줄로 합친다', () => {
    expect(buildQueryString('밸류헌터', ['#상승', '#무위험'])).toBe('밸류헌터 #상승 #무위험');
    expect(buildQueryString('', ['#코인'])).toBe('#코인');
    expect(buildQueryString('  ', [])).toBe('');
  });

  it('합친 문자열을 다시 파싱하면 원래 조건이 나온다 (왕복이 깨지지 않는다)', () => {
    const q = parseCardQuery(buildQueryString('밸류헌터', ['#코인', '#상승', '#신뢰도 4이상']));
    expect(q.text).toBe('밸류헌터');
    expect(q.assetClasses).toEqual(['CRYPTO']);
    expect(q.direction).toBe('UP');
    expect(q.minConfidence).toBe(4);
  });
});

describe('등급 서열 비교', () => {
  it('TIERS 순서가 곧 서열', () => {
    expect(tierAtLeast('PLATINUM', 'GOLD')).toBe(true);
    expect(tierAtLeast('GOLD', 'GOLD')).toBe(true);
    expect(tierAtLeast('SILVER', 'GOLD')).toBe(false);
    expect(tierAtLeast('CHALLENGER', 'SILVER')).toBe(true);
  });
});
