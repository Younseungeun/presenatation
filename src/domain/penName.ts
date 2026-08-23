/**
 * 필명 — **앱에서 이 사람을 부르는 유일한 이름** (2026-08-20 사용자 확정: 가입 필수).
 *
 * 전에는 선택이었다. 그래서 구매만 하는 이용자는 대개 이름이 없었고, 그 사람이 화면에
 * 나타나야 하는 자리(신고자·문의자·팔로워)마다 **부를 이름이 없어서** 각 화면이 제
 * 나름의 대체 표기를 지어냈다 — `이름을 밝히지 않은 이용자`, 계정 id 꼬리, 심지어
 * 자리표시자 이메일(`9a20…@identity.local`)까지. 같은 사람이 화면마다 다른 이름으로
 * 보였고, 그중 어느 것도 본인이 자기 이름으로 알아볼 수 없는 값이었다.
 *
 * 실명으로 대신할 수도 없다 — 실명은 계좌 예금주 대조용으로만 받은 값이라, 그걸로
 * 부르면 이용자는 자기가 알려준 적 없는 이름을 관리자에게서 듣게 된다.
 *
 * 그래서 이름은 **가입할 때 한 번 받는다.** 필명이 없는 계정이 안 생기면 대체 표기를
 * 지어낼 자리도 함께 사라진다.
 */

/**
 * @근거 설계 한 글자 이름은 목록에서 옆 사람과 구별되지 않고(신고자 3명이 전부 "김"),
 * 오타·빈 입력이 그대로 통과한다. 두 글자면 사람 이름·활동명의 최소 단위가 된다
 */
export const PEN_NAME_MIN = 2;

/**
 * @근거 설계 리포트 카드·순위표 한 줄에 들어가는 길이. 넘으면 이름이 잘려
 * 목록에서 서로 구별되지 않는다 (기존 입력란 maxLength와 같은 값)
 */
export const PEN_NAME_MAX = 30;

/** 공백만 다른 두 이름을 다른 사람처럼 보이게 두지 않는다 */
export function normalizePenName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export interface PenNameCheck {
  ok: boolean;
  reason?: string;
}

export function checkPenName(raw: string): PenNameCheck {
  const v = normalizePenName(raw);
  if (v.length === 0) return { ok: false, reason: '필명을 적어 주세요' };
  if (v.length < PEN_NAME_MIN) {
    return { ok: false, reason: `필명은 ${PEN_NAME_MIN}자 이상이어야 합니다` };
  }
  if (v.length > PEN_NAME_MAX) {
    return { ok: false, reason: `필명은 ${PEN_NAME_MAX}자까지 쓸 수 있습니다` };
  }
  // 이름 자리에 연락처가 들어오는 것을 막는다 — 앱 밖 거래 유인의 가장 싼 통로가
  // "이름"이다(소개말에 이미 같은 규칙이 있다 — domain/researcherBio.ts)
  if (/@|https?:\/\/|\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4}/.test(v)) {
    return { ok: false, reason: '필명에 연락처·주소를 쓸 수 없습니다' };
  }
  return { ok: true };
}
