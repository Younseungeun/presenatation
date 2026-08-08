import { describe, expect, it } from 'vitest';
import { BIO_MAX_LENGTH, normalizeBio, validateBio } from '../researcherBio';

// 소개말은 리서처의 유일한 자유 서술 공간이라 PR 가치가 크지만,
// 리포트 제목과 같은 위험(자유 입력이 정책을 우회하는 통로)을 갖는다.

describe('허용 — 사람을 소개하는 말', () => {
  it('관심 분야 서술은 통과한다 (마스킹이 지키는 것은 "이 카드의 종목"이지 관심 분야가 아니다)', () => {
    expect(validateBio('반도체·2차전지를 주로 봅니다')).toBeNull();
    expect(validateBio('10년차 크립토 온체인 분석')).toBeNull();
  });

  it('경력 서술도 통과한다', () => {
    expect(validateBio('전직 증권사 애널리스트, 현재는 독립 리서처입니다')).toBeNull();
  });

  it('미설정·빈 문자열은 언제나 통과 (선택 항목)', () => {
    expect(validateBio(null)).toBeNull();
    expect(validateBio('')).toBeNull();
    expect(validateBio('   ')).toBeNull();
  });
});

describe('차단 — 수익률 약속', () => {
  it('퍼센트 수치는 막는다 — 자기 신고 성과는 트랙레코드를 대체할 수 없다', () => {
    expect(validateBio('월 평균 30% 수익')?.reason).toContain('수익률');
    expect(validateBio('적중률 92.5 % 달성')?.reason).toContain('수익률');
  });

  it('보장·확정 표현을 막는다', () => {
    expect(validateBio('원금 보장형 전략')).not.toBeNull();
    expect(validateBio('무조건 오르는 종목만 고릅니다')).not.toBeNull();
    expect(validateBio('손실 없는 매매')).not.toBeNull();
  });
});

describe('차단 — 플랫폼 밖으로 빼내는 통로', () => {
  it('외부 연락처·링크를 막는다 (1:1 상담은 투자자문업 영역)', () => {
    expect(validateBio('카톡 오픈채팅방 운영 중')?.reason).toContain('외부 연락처');
    expect(validateBio('텔레그램 채널 있습니다')).not.toBeNull();
    expect(validateBio('자세한 건 https://example.com 에서')).not.toBeNull();
    expect(validateBio('문의는 @myhandle 로')).not.toBeNull();
  });

  it('전화번호를 막는다', () => {
    expect(validateBio('연락처 010-1234-5678')).not.toBeNull();
    expect(validateBio('01012345678 로 주세요')).not.toBeNull();
  });
});

describe('길이', () => {
  it(`${BIO_MAX_LENGTH}자를 넘으면 막는다`, () => {
    expect(validateBio('가'.repeat(BIO_MAX_LENGTH))).toBeNull();
    expect(validateBio('가'.repeat(BIO_MAX_LENGTH + 1))?.reason).toContain(
      String(BIO_MAX_LENGTH),
    );
  });
});

describe('정규화', () => {
  it('앞뒤 공백을 없애고 연속 공백을 하나로 줄인다', () => {
    expect(normalizeBio('  반도체를   주로 봅니다  ')).toBe('반도체를 주로 봅니다');
  });

  it('내용이 없으면 null — 빈 문자열이 저장돼 화면에 빈 인용부호가 남지 않게', () => {
    expect(normalizeBio('   ')).toBeNull();
    expect(normalizeBio('')).toBeNull();
    expect(normalizeBio(null)).toBeNull();
  });

  it('줄바꿈도 공백 하나로 접힌다 (한 줄 표시가 전제)', () => {
    expect(normalizeBio('첫 줄\n\n둘째 줄')).toBe('첫 줄 둘째 줄');
  });
});
