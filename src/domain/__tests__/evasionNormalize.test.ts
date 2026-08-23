import { describe, expect, it } from 'vitest';
import { applyRules } from '../compliance';
import type { ScreeningInput } from '../compliance';
import {
  composeJamo,
  deepNormalize,
  deepNormalizeWithOrigin,
  gapProfile,
  josaVariants,
  mixedScriptTokens,
  substitutionDistance,
} from '../evasionNormalize';

// 13차 — 적대적 코퍼스(training/holdout/evasion-13.json)가 찾아낸 것들을 못 박는다.
//
// 이 파일의 시험 대부분은 **회귀 시험**이다. 각 항목은 실제로 뚫렸던 입력이고,
// 그 입력이 다시 통과하면 실패한다.

const CARD = {
  assetClass: 'KR_EQUITY',
  assetName: '삼성전자',
  direction: 'UP',
  targetType: 'RETURN_PCT',
  magnitudePct: 12,
  horizonDays: 90,
  confidence: 5,
} as const;

const screen = (content: string, known?: ReadonlySet<string>) =>
  applyRules({ title: '', summary: '', content, ...CARD } as ScreeningInput, {
    knownNames: known,
  });

const categories = (content: string, known?: ReadonlySet<string>) =>
  new Set(screen(content, known).map((f) => f.category));

describe('자모 합성', () => {
  it('흩어 쓴 낱자를 음절로 되돌린다', () => {
    expect(composeJamo('ㅇㅝㄴㄱㅡㅁ')).toBe('원금');
    expect(composeJamo('ㅋㅏ')).toBe('카');
  });

  it('뒤에 모음이 오면 받침으로 가져가지 않는다', () => {
    // ㄴ 은 `간`의 받침이 아니라 `나`의 초성이다
    expect(composeJamo('ㄱㅏㄴㅏ')).toBe('가나');
  });

  it('합성할 수 없는 글자는 그대로 둔다', () => {
    expect(composeJamo('삼성전자')).toBe('삼성전자');
    expect(composeJamo('ㄱ')).toBe('ㄱ');
  });
});

describe('깊은 정규화', () => {
  it('둘러싸인 문자를 푼다', () => {
    expect(deepNormalize('ⓘⓓ')).toBe('id');
    expect(deepNormalize('Ⓣⓔⓛⓔ')).toBe('Tele');
  });

  it('정상 한국어는 건드리지 않는다', () => {
    for (const s of ['삼성SDI의 하반기 실적', 'POSCO홀딩스와 LG화학', 'KODEX 200 ETF']) {
      expect(deepNormalize(s)).toBe(s);
    }
  });

  it('위치 지도가 원문을 가리킨다 — 인용문이 원문 기준이어야 하므로', () => {
    const text = 'ㅇ ㅝ ㄴ ㄱ ㅡ ㅁ 보장';
    const { text: normalized, origin } = deepNormalizeWithOrigin(text);
    expect(normalized).toContain('원금');
    // 모든 위치가 원문 범위 안이고 단조 증가한다
    expect(origin.length).toBe(normalized.length);
    for (let i = 1; i < origin.length; i += 1) expect(origin[i]).toBeGreaterThan(origin[i - 1]);
    expect(origin[origin.length - 1]).toBeLessThan(text.length);
  });
});

describe('치환 거리 (P-6)', () => {
  it('대조군은 전부 0이다 — 정상 한국어에는 NFKC 가 건드릴 것이 없다', () => {
    const controls = [
      '삼성SDI의 하반기 실적을 분석했습니다',
      'POSCO홀딩스와 LG화학을 비교합니다',
      'NAVER와 KT&G의 배당 정책 차이',
      'SK하이닉스 HBM3E 양산 일정 점검',
      '과거 수익률이 미래 수익을 보장하지 않습니다',
      '원금이 보장되지 않는 상품이므로 유의하십시오',
      'KODEX 200 ETF의 추적오차를 살펴봅니다',
      '본 리포트는 1:1 자문이 아니며 불특정 다수를 대상으로 합니다',
    ];
    for (const c of controls) expect(substitutionDistance(c)).toBe(0);
  });

  it('유니코드·자모 회피에서만 0을 넘는다', () => {
    expect(substitutionDistance('ⓘⓓ : kakao_trust100 입니다')).toBeGreaterThan(0);
    expect(substitutionDistance('ㅇ ㅝ ㄴ ㄱ ㅡ ㅁ ㅂ ㅗ ㅈ ㅏ ㅇ 선언')).toBeGreaterThan(0);
  });

  it('한/영 혼용에는 반응하지 않는다 — 이 신호의 담당 범위가 아니다', () => {
    // 13차 P-6 의 "만능 회피 신호" 결론이 반증된 지점. 문서가 사실과 어긋나지 않게 고정한다
    expect(substitutionDistance('텔le그ram 으로 오세요')).toBe(0);
  });
});

describe('구분기호 간격 (P-2)', () => {
  it('고르게 벌린 것은 회피로 본다', () => {
    for (const span of ['텔.레.그.램', '텔/레/그/램', '텔_레_그_램', '텔 레 그 램', '원.금.보.장']) {
      expect(gapProfile(span).spread, span).toBe(true);
    }
  });

  it('한 곳에만 끼어든 것은 우연으로 본다', () => {
    for (const span of ['복원. 금보장', '원금이 보장되지', '수익을 보장하지 않습니다']) {
      expect(gapProfile(span).spread, span).toBe(false);
    }
  });
});

describe('조사 제거 (P-1)', () => {
  it('교착어라 조사를 떼야 종목명이 맞는다', () => {
    expect(josaVariants('삼성SDI의')).toContain('삼성SDI');
    expect(josaVariants('POSCO홀딩스와')).toContain('POSCO홀딩스');
    expect(josaVariants('LG화학을')).toContain('LG화학');
  });

  it('원형도 후보에 남는다 — 조사가 없는 표기가 대부분이다', () => {
    expect(josaVariants('삼성SDI')).toContain('삼성SDI');
  });
});

describe('문자 혼용 (P-1)', () => {
  const known = new Set(['삼성sdi', 'posco홀딩스', 'lg화학', 'naver', 'kt&g', 'sk하이닉스']);

  it('아는 이름이 없으면 침묵한다 — 화이트리스트 없이 켜면 대조군 8건 중 5건이 오탐이었다', () => {
    expect(mixedScriptTokens('텔le그ram 으로 오세요', new Set())).toEqual([]);
  });

  it('상장 종목은 문자가 섞여 있어도 통과한다', () => {
    for (const s of [
      '삼성SDI의 하반기 실적을 분석했습니다',
      'POSCO홀딩스와 LG화학을 비교합니다',
      'NAVER와 KT&G의 배당 정책 차이',
    ]) {
      expect(mixedScriptTokens(s, known), s).toEqual([]);
    }
  });

  it('종목이 아닌 일반 금융 용어도 통과한다', () => {
    expect(mixedScriptTokens('SK하이닉스 HBM3E 양산 일정 점검', known)).toEqual([]);
    expect(mixedScriptTokens('KODEX 200 ETF의 추적오차', known)).toEqual([]);
  });

  it('모르는 이름인데 문자가 섞였으면 지적한다', () => {
    expect(mixedScriptTokens('텔le그ram 으로 오세요', known).length).toBeGreaterThan(0);
    expect(mixedScriptTokens('카ka5톡 검색', known).length).toBeGreaterThan(0);
  });

  it('낱자가 낱말에 섞인 것은 정상 표기에 없다', () => {
    expect(mixedScriptTokens('ㅋㅏ톡 주세요', known)[0]?.reason).toBe('BARE_JAMO');
  });
});

describe('규칙 통합 — 뚫렸던 입력이 다시 통과하지 않는다', () => {
  const known = new Set(['삼성sdi', 'posco홀딩스', 'lg화학', 'naver', 'kt&g', 'sk하이닉스', '카카오']);

  it('마침표로 벌린 회피를 잡는다 (예전 가드가 통째로 흘려보내던 자리)', () => {
    expect(categories('텔.레.그.램 으로 오세요')).toContain('SOLICIT_CONTACT');
    expect(categories('원.금.보.장 합니다')).toContain('PROFIT_GUARANTEE');
  });

  it('우연히 붙는 문장은 여전히 지나간다', () => {
    expect(categories('복원. 금보장 구역입니다')).not.toContain('PROFIT_GUARANTEE');
  });

  it('필드 경계를 넘은 매칭은 우연이다', () => {
    // 제목·요약·본문은 개행으로 이어 붙는다 — 그 이음매를 넘은 매칭은 회피가 아니다
    const findings = applyRules(
      { title: '복원', summary: '금보장 구역', content: '정상적인 분석입니다', ...CARD } as ScreeningInput,
      { knownNames: known },
    );
    expect(findings.map((f) => f.category)).not.toContain('PROFIT_GUARANTEE');
  });

  it('낱자·유니코드 회피를 잡는다', () => {
    expect(categories('ㅇ ㅝ ㄴ ㄱ ㅡ ㅁ ㅂ ㅗ ㅈ ㅏ ㅇ 선언', known)).toContain('SCREENING_EVASION');
    expect(categories('ⓘⓓ : kakao_trust100 입니다', known)).toContain('SCREENING_EVASION');
  });

  it('한/영 혼용을 잡는다 — 뜻은 해독하지 않고 훼손 사실만 지적한다', () => {
    expect(categories('텔le그ram 으로 오세요', known)).toContain('SCREENING_EVASION');
    expect(categories('원gold 보jang 조건입니다', known)).toContain('SCREENING_EVASION');
  });

  it('대조군 8건은 여전히 아무 소견도 내지 않는다', () => {
    const controls = [
      '삼성SDI의 하반기 실적을 분석했습니다',
      'POSCO홀딩스와 LG화학을 비교합니다',
      'NAVER와 KT&G의 배당 정책 차이',
      'SK하이닉스 HBM3E 양산 일정 점검',
      '과거 수익률이 미래 수익을 보장하지 않습니다',
      '원금이 보장되지 않는 상품이므로 유의하십시오',
      'KODEX 200 ETF의 추적오차를 살펴봅니다',
      '본 리포트는 1:1 자문이 아니며 불특정 다수를 대상으로 합니다',
    ];
    for (const c of controls) expect([...categories(c, known)], c).toEqual([]);
  });

  it('회피 소견은 절대 즉시 거절이 아니다', () => {
    // 오탐이 0으로 측정됐어도 표본이 44건뿐이다. 뜻이 아니라 모양을 보는 신호에
    // 사람 확인 없는 거절 권한을 주지 않는다
    for (const s of ['텔le그ram 으로 오세요', 'ㅋㅏ톡 주세요', '텔.레.그.램 으로 오세요']) {
      const evasion = screen(s, known).filter((f) => f.category === 'SCREENING_EVASION');
      for (const f of evasion) expect(f.severity, s).toBe('WARN');
    }
  });
});

describe('마크다운·강조 표기 (13차 검토자 질문)', () => {
  const known = new Set(['삼성sdi', 'sk하이닉스', 'brk/b']);

  it('낱말 안에 낀 강조 기호가 종목 대조를 깨뜨리지 않는다', () => {
    // `**삼성SDI**의` 는 바깥만 다듬으면 `삼성SDI**의` 로 남아 오탐이었다
    expect(mixedScriptTokens('**삼성SDI**의 하반기 전망', known)).toEqual([]);
    expect(mixedScriptTokens('__SK하이닉스__ 실적', known)).toEqual([]);
  });

  it('기호가 든 정식 티커도 통과한다 — 기호를 지우는 꼴만 쓰면 이쪽이 샌다', () => {
    expect(mixedScriptTokens('BRK/B 분석', known)).toEqual([]);
  });

  it('마크다운은 치환 거리를 왜곡하지 않는다 — 견주기 전에 양쪽에서 걷힌다', () => {
    for (const s of ['**삼성SDI**의 하반기 전망', '[핵심] `목표가` 도달', '### 결론 — __주의__']) {
      expect(substitutionDistance(s), s).toBe(0);
    }
  });

  it('강조로 감싸도 회피는 여전히 잡힌다', () => {
    expect(mixedScriptTokens('**텔le그ram** 으로 오세요', known).length).toBeGreaterThan(0);
  });
});

describe('보이지 않는 문자 (14차 R-3)', () => {
  const known = new Set(['삼성sdi', 'sk하이닉스', 'naver', 'kt&g', 'posco홀딩스', 'lg화학']);
  const between = (c: string, s: string) => s.split('').join(c);

  // 실측: 이 중 다섯이 규칙을 그대로 통과했다. 잡히던 셋(BOM·전각공백·NBSP)조차
  // 설계된 방어가 아니라 JS `\s`의 우연이었다
  it.each([
    ['제로폭 공백 ZWSP', '\u200B'],
    ['제로폭 비접합 ZWNJ', '\u200C'],
    ['제로폭 접합 ZWJ', '\u200D'],
    ['워드 조이너', '\u2060'],
    ['소프트 하이픈', '\u00AD'],
    ['좌우 재정의', '\u202E'],
    ['BOM', '\uFEFF'],
    ['전각 공백', '\u3000'],
    ['NBSP', '\u00A0'],
  ])('%s 를 끼워 넣어도 잡는다', (_name, ch) => {
    expect(categories(between(ch, '원금보장'), known)).toContain('PROFIT_GUARANTEE');
  });

  it('한글 위의 결합 문자는 지우지 않고 훼손으로 지적한다', () => {
    // 지우면 공격자 대신 원문을 복원해 주는 꼴이다
    expect(categories(between('\u0301', '원금보장'), known)).toContain('SCREENING_EVASION');
  });

  it('유니코드 태그 블록도 훼손으로 지적한다', () => {
    expect(categories('정상적인 분석입니다\u{E0041}\u{E0042}', known)).toContain('SCREENING_EVASION');
  });

  it('이모지와 라틴 결합 문자는 건드리지 않는다', () => {
    // 리서처가 정상적으로 쓰고, 라틴에서 결합 문자는 뜻을 바꾼다 (café)
    expect([...categories('실적 개선이 뚜렷합니다 📈', known)]).toEqual([]);
    expect([...categories('cafe\u0301 스타일 매장 확대', known)]).toEqual([]);
  });
});

describe('정상 합성어와 회피를 가르는 것은 대소문자다 (15차)', () => {
  const known = new Set(['삼성sdi', 'lg에너지솔루션', 'posco홀딩스']);

  it('대문자 약어가 붙은 합성어는 정상이다', () => {
    // 한글+라틴만 요구했을 때 전부 오탐이던 것들
    for (const s of ['AI반도체 업황', 'IT서비스 부문', 'ESG경영 평가', 'EV배터리 수요', 'M&A시장 활황', 'HBM3E 양산']) {
      expect(mixedScriptTokens(s, known), s).toEqual([]);
    }
  });

  it('한 글자 소문자는 정상 표기다', () => {
    expect(mixedScriptTokens('e커머스 성장률', known)).toEqual([]);
  });

  it('소문자 낱말을 끼워 넣은 것은 회피다', () => {
    for (const s of ['텔le그ram', 'Tele그램', '카ka5톡', 'KaKao톡', 'won금보장', '보jang']) {
      expect(mixedScriptTokens(s, known).length, s).toBeGreaterThan(0);
    }
  });

  it('한글+숫자는 회피가 아니다 — 가장 흔한 한국어 표기다', () => {
    for (const s of ['3분기 매출', '2차전지 소재주', '2026년 전망', '1주당 배당', '최근 3일간']) {
      expect(mixedScriptTokens(s, known), s).toEqual([]);
    }
  });
});

describe('종목명은 방패가 되지 않는다 (15차 S-2)', () => {
  const known = new Set(['올 인 퓨처테크 얼라이언스', '루시드 다이어그노스틱스', '삼성sdi', '삼성전자']);
  const cat = (s: string) => new Set(applyRules({ title: '', summary: '', content: s, ...CARD } as ScreeningInput, { knownNames: known }).map((f) => f.category));

  it('이름 안에 통째로 든 매칭은 면제한다', () => {
    // `올 인 퓨처테크` → `올인` / `루시드 다이어…` → `시드 다`
    expect([...cat('올 인 퓨처테크 얼라이언스 실적 분석')]).toEqual([]);
    expect([...cat('루시드 다이어그노스틱스 3분기 전망')]).toEqual([]);
  });

  it('이름 옆의 진짜 위반은 그대로 잡는다', () => {
    expect(cat('삼성SDI 텔레그램으로 오세요')).toContain('SOLICIT_CONTACT');
    expect(cat('올 인 퓨처테크 얼라이언스 원금보장 해드립니다')).toContain('PROFIT_GUARANTEE');
    // 앞쪽의 가려진 매칭 때문에 규칙 전체를 포기하면 이게 통과한다 (firstUnmaskedMatch)
    expect(cat('루시드 다이어그노스틱스 풀 매수 하세요')).toContain('RISK_INDUCEMENT');
  });
});

describe('연락처 규칙 (15차 S-1)', () => {
  const known = new Set(['삼성전자', '삼성에스디에스']);
  const cat = (s: string) => new Set(applyRules({ title: '', summary: '', content: s, ...CARD } as ScreeningInput, { knownNames: known }).map((f) => f.category));

  it('전화번호를 잡는다', () => {
    for (const s of ['연락처 010-8923-7890 입니다', '01089237890 문자주세요', '문의 주세요 010 3321 4455', '연락처 공일공 팔구이삼 칠팔구공']) {
      expect(cat(s), s).toContain('SOLICIT_CONTACT');
    }
  });

  it('리포트에 흔한 숫자는 건드리지 않는다', () => {
    for (const s of [
      '목표가 71,000원을 제시합니다',
      '2026-08-20 실적 발표 예정',
      '3분기 매출 1,234억원',
      'PER 12.5배 수준입니다',
      // 티커 + 연도 — 공백을 걷어내면 `0182602026`이 되어 휴대전화와 구별되지 않는다.
      // 그래서 숫자 규칙은 원문에서만 돈다 (Rule.rawOnly)
      '삼성에스디에스(018260) 2026년 전망',
      '1주당 8,923원 배당',
      '최근 3일간 5% 상승했습니다',
    ]) {
      expect([...cat(s)], s).toEqual([]);
    }
  });
});

describe('신조어·단위 표기 (17차 반증 조건 3)', () => {
  const known = new Set(['삼성sdi', 'sk하이닉스']);

  // 검토가 지목한 반증 조건이 **실제로 터졌다**: 붙여 쓴 합성어 25건 중 12건 오탐.
  // `nm공정`·`bps금리`·`pp상승`·`iPhone판매`·`macOS용` … 전부 정상 표기다.
  // 가르는 것은 **라틴 조각이 아는 용어인가** 였다 — 회피의 라틴 조각은 아는 용어가 아니다.
  it.each([
    'arXiv논문', 'gRPC기반', 'pBFT합의', 'pH조절제', 'mRNA백신', 'eSIM칩', 'iOS앱', 'macOS용',
    'iPhone판매', 'iPad출하', 'nm공정', 'xEV시장', 'eVTOL기체', 'mmWave대역', 'sLLM경량화',
    'microLED개발', 'bps금리', 'pp상승', 'kWh단가', 'e커머스', 'webOS기반', 'eSports산업', 'iGaming시장',
  ])('붙여 쓴 %s 는 정상이다', (s) => {
    expect(mixedScriptTokens(s, known), s).toEqual([]);
  });

  it('회피의 라틴 조각은 아는 용어가 아니라 그대로 걸린다', () => {
    // 여기에 `won`·`ka`·`tele` 를 용어 사전에 넣으면 이 시험이 빨개진다 — 넣지 말 것
    for (const s of ['텔le그ram', 'Tele그램', '카ka5톡', 'KaKao톡', 'won금보장', '보jang', '원금bojang']) {
      expect(mixedScriptTokens(s, known).length, s).toBeGreaterThan(0);
    }
  });
});
