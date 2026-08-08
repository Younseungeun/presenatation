// 리서처 소개말 정책.
//
// 소개말은 리서처가 자기를 파는 유일한 자유 서술 공간이라 PR로서 가치가 크지만,
// 자유 입력이라는 점에서 리포트 제목과 같은 위험을 갖는다. 세 가지를 막는다:
//
//  ① 수익률 약속 — "월 30% 수익" 같은 문구는 손실보전 약정·투자권유 소지가 있다
//     (기획 §1 법적 경계). 성과는 판정된 트랙레코드가 말하게 두고 자기 신고는 막는다
//  ② 외부 연락 유도 — 카톡·텔레그램·전화번호는 1:1 맞춤 상담(투자자문업 라이선스
//     영역)으로 넘어가는 통로이고, 플랫폼 밖 거래 유인이기도 하다
//  ③ 단정적 표현 — "보장·확정·무조건"은 ①과 같은 이유
//
// 종목명 자체는 여기서 막지 않는다: 소개말은 특정 카드에 붙는 글이 아니라 사람에게
// 붙는 글이라, "반도체를 주로 봅니다" 같은 서술은 마스킹을 뚫지 않고 오히려 유용하다.
// 마스킹이 지키는 것은 "이 카드의 종목이 무엇인가"이지 관심 분야가 아니다.

export const BIO_MAX_LENGTH = 80;

export interface BioViolation {
  reason: string;
}

const RULES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // 숫자 + % — 띄어쓰기·소수점 허용
    pattern: /\d+(\.\d+)?\s*%/,
    reason: '수익률·확률 수치는 소개말에 쓸 수 없습니다. 성과는 판정된 트랙레코드로 표시됩니다',
  },
  {
    pattern: /(보장|확정\s*수익|무조건|원금\s*보장|손실\s*없)/,
    reason: '수익을 약속하는 표현은 쓸 수 없습니다',
  },
  {
    pattern: /(카톡|카카오톡|오픈채팅|텔레그램|telegram|@[A-Za-z0-9_]{3,}|https?:\/\/|www\.)/i,
    reason: '외부 연락처·링크는 쓸 수 없습니다. 1:1 상담은 제공하지 않습니다',
  },
  {
    // 전화번호 — 하이픈 유무 무관
    pattern: /\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4}/,
    reason: '전화번호는 쓸 수 없습니다',
  },
];

/**
 * 소개말 검증. 통과하면 null, 걸리면 사유를 돌려준다.
 * 빈 값(미설정)은 언제나 통과 — 소개말은 선택 항목이다.
 */
export function validateBio(bio: string | null): BioViolation | null {
  if (bio === null) return null;
  const text = bio.trim();
  if (text.length === 0) return null;
  if (text.length > BIO_MAX_LENGTH) {
    return { reason: `소개말은 ${BIO_MAX_LENGTH}자까지 쓸 수 있습니다` };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { reason: rule.reason };
  }
  return null;
}

/** 저장용 정규화 — 공백 정리 후 빈 문자열은 null(미설정)로 */
export function normalizeBio(bio: string | null): string | null {
  if (bio === null) return null;
  const text = bio.trim().replace(/\s+/g, ' ');
  return text.length === 0 ? null : text;
}
