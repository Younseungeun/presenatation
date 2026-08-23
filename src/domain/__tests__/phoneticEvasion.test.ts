import { describe, expect, it } from 'vitest';
import { applyRules } from '../compliance';
import type { ScreeningInput } from '../compliance';
import { findPhoneticEvasion, toJamo } from '../phoneticEvasion';

// 13차에 "음성 변형은 규칙 불가"라고 적었던 것을 뒤집는 층이다.
// 변형은 무한해도 **원본으로부터의 거리는 유한하다**.

const CARD = {
  assetClass: 'KR_EQUITY', assetName: '삼성전자', direction: 'UP',
  targetType: 'RETURN_PCT', magnitudePct: 12, horizonDays: 90, confidence: 5,
} as const;
const cat = (s: string, known = new Set<string>()) =>
  new Set(applyRules({ title: '', summary: '', content: s, ...CARD } as ScreeningInput, { knownNames: known }).map((f) => f.category));

describe('자모 분해', () => {
  it('음절을 초·중·종성으로 푼다', () => {
    expect(toJamo('강')).toEqual(['ㄱ', 'ㅏ', 'ㅇ']);
    expect(toJamo('가')).toEqual(['ㄱ', 'ㅏ']);
    expect(toJamo('a1')).toEqual(['a', '1']);
  });
});

describe('음성 변형 (16차)', () => {
  it('모음 하나를 바꾼 변형을 잡는다', () => {
    for (const [s, want] of [
      ['텔레그렘 으로 오세요', 'SOLICIT_CONTACT'],
      ['텔렛그램 방 초대', 'SOLICIT_CONTACT'],
      ['카카오툭 아이디 드립니다', 'SOLICIT_CONTACT'],
      ['카톢 주세요', 'SOLICIT_CONTACT'],
      ['리딩빵 운영중', 'SOLICIT_CONTACT'],
      ['단톡빵 초대합니다', 'SOLICIT_CONTACT'],
      ['원금보쟝 해드립니다', 'PROFIT_GUARANTEE'],
      ['수익보쟝 드립니다', 'PROFIT_GUARANTEE'],
    ] as const) {
      expect(cat(s), s).toContain(want);
    }
  });

  it('띄어 쓴 변형도 잡는다 — 기호를 걷어낸 사본 위에서 창을 민다', () => {
    expect(cat('텔레 그렘 으로 오세요')).toContain('SOLICIT_CONTACT');
  });

  it('발음이 비슷한 정상 낱말은 건드리지 않는다', () => {
    for (const s of [
      '카카오뱅크와 카카오페이의 실적을 비교합니다',
      '오픈뱅킹 확대가 은행권에 미치는 영향',
      '리딩기업으로 자리잡은 반도체 소재주입니다',
      '원금손실 가능성을 반드시 확인하십시오',
      '텔레비전 판매가 회복세로 돌아섰습니다',
      '확정급여형 퇴직연금 시장이 커지고 있습니다',
      '그램당 단가가 하락했습니다',
      '상담역으로 영입된 인사가 있습니다',
    ]) {
      expect([...cat(s)], s).toEqual([]);
    }
  });

  it('부정 문맥을 반드시 태운다 — 표준 면책 문구가 걸렸었다', () => {
    // 근사 매칭은 정확 매칭보다 정상 문장에 더 가까이 간다. 그래서 이 장치가 더 중요하다
    expect([...cat('원금이 보장되지 않는 상품이므로 유의하십시오')]).toEqual([]);
    expect([...cat('과거 수익률이 미래 수익을 보장하지 않습니다')]).toEqual([]);
  });

  it('낱말이 그대로 들어 있으면 이 층은 침묵한다', () => {
    // 정확히 든 낱말은 **언제나 자기 자신의 근사 매칭을 만든다**
    // (`원금보장구` 는 `원금보장` 과 자모 거리 2). 근사는 근사일 때만 본다
    expect(findPhoneticEvasion('실적은 복원. 금보장 구역 개발도 호재입니다')).toEqual([]);
  });

  it('종목명은 처음부터 뺀다', () => {
    const known = new Set(['카카오뱅크', '카카오페이']);
    expect(findPhoneticEvasion('카카오뱅크 실적 분석', known)).toEqual([]);
  });
});

describe('완곡한 손실 보전 (16차)', () => {
  it('"손실이 0" 갈래를 잡는다', () => {
    for (const s of ['손실율 0% 구조로 설계했습니다', '리스크 제로 선언합니다', '무손실 구조입니다', '다운사이드 제로입니다']) {
      expect(cat(s), s).toContain('PROFIT_GUARANTEE');
    }
  });

  it('"전액 돌려준다" 갈래를 잡는다', () => {
    for (const s of ['실패 시 전액 케어해 드립니다', '전액 보전해 드립니다', '100% 현금 보전해 드립니다']) {
      expect(cat(s), s).toContain('PROFIT_GUARANTEE');
    }
  });

  it('정상 리스크 서술은 건드리지 않는다', () => {
    for (const s of ['손실 위험을 0으로 만들 수는 없습니다', '리스크 관리가 핵심입니다', '다운사이드 리스크를 점검합니다', '전액 출자 전환이 이뤄졌습니다']) {
      expect([...cat(s)], s).toEqual([]);
    }
  });
});

describe('채널을 가리키는 은유 (16차)', () => {
  it('[색·모양] + [앱·채널] 구조를 잡는다', () => {
    for (const s of ['노란 앱 검색창에 스톡킹 검색하세요', '파란 비행기 아이콘 앱에서 찾으세요', '제 프로필 상단 링크 참조하세요']) {
      expect(cat(s), s).toContain('SOLICIT_CONTACT');
    }
  });

  it('색이 상호에 든 것은 건드리지 않는다 — 검토가 지목한 반증 조건', () => {
    expect([...cat('노란우산공제 관련주를 분석합니다')]).toEqual([]);
    expect([...cat('회사 프로필을 살펴보면 매출 구조가 다각화되어 있습니다')]).toEqual([]);
  });
});

describe('연락처 묶음 모양 (16차 T-3)', () => {
  const known = new Set(['삼성에스디에스', '삼성전자']);

  it('사람이 쓰는 모든 표기를 잡는다', () => {
    for (const s of ['연락처 010-8923-7890 입니다', '01089237890 문자주세요', '010 8923 7890 주세요',
      '０１０-８９２３-７８９０ 로 연락', '0 1 0 - 8 9 2 3 - 7 8 9 0']) {
      expect(cat(s, known), s).toContain('SOLICIT_CONTACT');
    }
  });

  it('티커·날짜·표 양식은 통과한다 — 정규식으로는 구별되지 않던 것들', () => {
    // `018260 2026년` 은 공백을 걷으면 `0182602026`(10자리, 01X 시작)이라
    // 휴대전화 정규식과 구별되지 않는다. 묶음 모양(6,4)이 전화번호 목록에 없어 빠진다
    for (const s of ['삼성에스디에스(018260) 2026년 전망', '010040 1990년 상장', '표 2 열 0 행 10',
      '2026-08-20 실적 발표', '1,234억원 매출', '010 사업부 매출']) {
      expect([...cat(s, known)], s).toEqual([]);
    }
  });
});

describe('종목명 마스킹은 방패가 되지 않는다 (16차 T-4)', () => {
  const known = new Set(['올 인 퓨처테크 얼라이언스', '루시드 다이어그노스틱스', '삼성전자']);

  it('이름 밖의 같은 표현은 그대로 잡는다', () => {
    // 검토는 마스킹 비율 30% 상한을 제안했으나, 실측에서 **정상 문장이 이미 63~79%**라
    // (`LG에너지솔루션과 SK하이닉스를 비교합니다` = 70%) 상한을 두면 정상 비교 리포트가
    // 무더기로 보류된다. 상한 대신 **완전 포함**만 면제하는 규칙이 이미 공격을 막는다
    expect(cat('올 인 퓨처테크 얼라이언스에 올인하세요', known)).toContain('RISK_INDUCEMENT');
    expect(cat('루시드 다이어그노스틱스 시드 다 넣으세요', known)).toContain('RISK_INDUCEMENT');
    expect(cat('올 인 퓨처테크 얼라이언스 원금보장 해드립니다', known)).toContain('PROFIT_GUARANTEE');
  });

  it('종목명을 도배해도 뒤의 위반이 살아 있다', () => {
    const s = '올 인 퓨처테크 얼라이언스 올 인 퓨처테크 얼라이언스 원금보장';
    expect(cat(s, known)).toContain('PROFIT_GUARANTEE');
  });

  it('이름만 있으면 통과한다', () => {
    expect([...cat('올 인 퓨처테크 얼라이언스 분석', known)]).toEqual([]);
  });
});

describe('숫자 자리의 동형자 (16차)', () => {
  const known = new Set(['삼성전자']);

  it('숫자가 대부분인 덩어리 안에서만 되돌린다', () => {
    expect(cat('O1O_3321_4455 문자주세요', known)).toContain('SOLICIT_CONTACT');
    expect(cat('0l0-3321-4455 로 연락', known)).toContain('SOLICIT_CONTACT');
  });

  it('문맥 밖의 영문 약어는 건드리지 않는다', () => {
    // "동형자 표는 항상 한 수 뒤"는 낱말에 대해서는 맞다. 숫자 자리는 다르다 —
    // 그 자리에 온 글자는 숫자를 흉내 낸 것 외에 다른 뜻이 없다
    for (const s of ['KOSPI200 지수 전망', 'HBM3E 4분기 양산', 'SP500 대비 초과수익', 'B2B2C 모델 전환']) {
      expect([...cat(s, known)], s).toEqual([]);
    }
  });
});
