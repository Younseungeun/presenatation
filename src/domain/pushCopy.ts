// 푸시에 실을 문구 — **알림함 본문을 그대로 보내지 않는다.**
//
// 이유는 하나다: **푸시는 잠금화면에 뜨고, 잠금화면은 남이 본다.**
// 알림함은 로그인한 본인만 열지만 푸시는 지하철에서 옆 사람이 읽는다.
// 그런데 지금 알림 본문에는 금액("환불 12,900원")·종목·계좌 뒷자리가 그대로 들어 있다.
//
// 그래서 **푸시 문구는 알림 본문에서 만들지 않고, 종류(type)에서 만든다.**
// 본문을 잘라 쓰거나 마스킹하는 방식은 택하지 않았다 — 자르면 새 알림 종류가 생길 때마다
// "이건 잘라도 되나"를 다시 판단해야 하고, 판단을 빠뜨린 한 번이 곧 유출이다.
// 종류에서 만들면 **모르는 종류는 자동으로 가장 안전한 문구**가 된다.
//
// 반대 방향의 실수도 있다: 안전하다고 전부 "새 알림이 있어요"로 뭉치면 아무도 안 누른다.
// 그래서 **무슨 일이 일어났는지까지는 말하고, 얼마인지·무엇인지는 말하지 않는다.**
//
// 예외는 **보안 알림**이다. "계좌가 바뀌었다"는 사실 자체가 경고여야 하고, 이걸 뭉개면
// 진짜 주인이 48시간 안에 동결을 걸 기회를 잃는다 — 여기서는 명확성이 사생활보다 앞선다
// (그리고 이 문구에는 금액도 계좌번호도 없다).

/** 잠금화면에 뜨는 한 줄. 앱 이름은 OS가 붙이므로 여기 적지 않는다 */
export interface PushCopy {
  title: string;
  body: string;
  /** 소리·배너를 강하게 띄울 것인가 — 돈이 걸린 보안 알림만 true */
  urgent: boolean;
}

/** 종류를 모를 때의 문구. **여기가 기본값이라 안전이 기본이 된다** */
const FALLBACK: PushCopy = {
  title: '인투빌에 새 알림이 있어요',
  body: '앱에서 확인해 주세요.',
  urgent: false,
};

const COPY: Record<string, PushCopy> = {
  // ── 판정·정산 (금액·종목을 싣지 않는다) ────────────────────
  JUDGMENT_RESULT: {
    title: '예측 카드 판정이 끝났어요',
    body: '결과와 정산 내용을 앱에서 확인해 주세요.',
    urgent: false,
  },
  UNDECIDABLE: {
    title: '판정할 수 없어 전액 환불됐어요',
    body: '자세한 내용을 앱에서 확인해 주세요.',
    urgent: false,
  },
  REFUND_EXECUTED: {
    title: '환불이 처리됐어요',
    body: '카드사 반영에는 며칠이 걸릴 수 있어요.',
    urgent: false,
  },
  PAYOUT_EXECUTED: {
    title: '정산금이 지급됐어요',
    body: '금액과 입금 계좌를 앱에서 확인해 주세요.',
    urgent: false,
  },
  COMPENSATION_EXECUTED: {
    title: '플랫폼 귀책 보상이 지급됐어요',
    body: '자세한 내용을 앱에서 확인해 주세요.',
    urgent: false,
  },
  CS_CANCEL: {
    title: '구매가 취소되고 환불됐어요',
    body: '자세한 내용을 앱에서 확인해 주세요.',
    urgent: false,
  },
  SALES_CLOSED: {
    title: '리포트 판매가 마감됐어요',
    body: '사유를 앱에서 확인해 주세요.',
    urgent: false,
  },

  // ── 검수 (리서처에게) ──────────────────────────────────────
  COMPLIANCE_REVIEW: {
    title: '리포트 검토 결과가 나왔어요',
    body: '앱에서 확인해 주세요.',
    urgent: false,
  },
  COMPLIANCE_PENDING: {
    title: '리포트가 검토 대기로 들어갔어요',
    body: '결과가 나오면 다시 알려드릴게요.',
    urgent: false,
  },
  COMPLIANCE_TAKEDOWN: {
    title: '게시된 리포트가 내려갔어요',
    body: '사유를 앱에서 확인해 주세요.',
    urgent: false,
  },
  ABUSE_REPORT_RESULT: {
    title: '신고 검토 결과가 나왔어요',
    body: '앱에서 확인해 주세요.',
    urgent: false,
  },
  // 리서처에게 — **판매가 멈춘 것을 본인만 모르는 상태가 가장 나쁘다.**
  // 어떤 리포트인지·왜인지는 잠금화면에 싣지 않는다(옆 사람이 본다). 앱을 열게만 한다
  ABUSE_SALES_SUSPENDED: {
    title: '리포트 판매가 일시 중단됐어요',
    body: '앱에서 확인해 주세요.',
    urgent: false,
  },

  // ── 보안 — **여기서는 명확성이 사생활보다 앞선다** ─────────
  // 진짜 주인이 이 줄을 보고 곧바로 정산을 동결할 수 있어야 쿨다운 48시간이 뜻을 갖는다.
  // 뭉뚱그리면 "무슨 알림이지" 하고 넘기고, 넘기는 순간 방어 장치가 없는 것과 같다
  PAYOUT_ACCOUNT_CHANGED: {
    title: '정산 계좌가 변경됐어요',
    body: '본인이 바꾼 것이 아니라면 지금 바로 앱에서 정산을 동결하세요.',
    urgent: true,
  },
  RISKY_LOGIN: {
    title: '낯선 기기에서 로그인됐어요',
    body: '본인이 아니라면 지금 바로 앱에서 기기를 지우세요.',
    urgent: true,
  },
  DEVICE_ADDED: {
    title: '새 기기가 등록됐어요',
    body: '본인이 아니라면 지금 바로 앱에서 확인해 주세요.',
    urgent: true,
  },
  PASSKEY_REMOVED: {
    title: '생체 로그인 기기가 삭제됐어요',
    body: '본인이 아니라면 지금 바로 앱에서 확인해 주세요.',
    urgent: true,
  },
  DEVICE_REMOVED: {
    title: '로그인 기기가 삭제됐어요',
    body: '본인이 아니라면 지금 바로 앱에서 확인해 주세요.',
    urgent: true,
  },
  PIN_LOCKED: {
    title: '간편 비밀번호가 잠겼어요',
    body: '여러 번 틀려 잠겼습니다. 본인 인증으로 다시 설정할 수 있어요.',
    urgent: true,
  },
};

/**
 * **운영자 전용 알림은 푸시로 내보내지 않는다.**
 * 텔레그램이 이미 그 일을 하고 있고(opsAlert), 두 경로로 같은 것이 오면 하나를 무시하게 된다.
 * 무시하는 습관이 생기면 정작 급한 것도 함께 무시된다.
 */
const NEVER_PUSH = new Set(['OPS_ALERT']);

export function shouldPush(type: string): boolean {
  return !NEVER_PUSH.has(type);
}

/** 알림 종류 → 잠금화면 문구. 모르는 종류는 가장 안전한 기본값으로 떨어진다 */
export function pushCopyFor(type: string): PushCopy {
  return COPY[type] ?? FALLBACK;
}

/**
 * 문구에 숫자가 섞이지 않았는지 — 시험이 이 함수로 전 문구를 훑는다.
 *
 * 금액·계좌 뒷자리·종목 코드는 전부 숫자를 끼고 나타난다. 사람이 새 문구를 추가하면서
 * "환불 12,900원이 처리됐어요"라고 쓰는 것을 막을 방법은 리뷰뿐인데, 리뷰는 언젠가 샌다.
 * 완벽한 검사는 아니지만 **가장 흔한 실수 한 가지를 기계가 막는다.**
 */
export function hasDigits(text: string): boolean {
  return /[0-9]/.test(text);
}

export const PUSH_COPY_TYPES = Object.keys(COPY);
