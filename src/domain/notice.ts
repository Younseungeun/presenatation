// 운영자 공지의 규칙 (순수 — 표를 만지지 않는다).
//
// 이 파일이 지키는 것은 하나다: **공지는 투자 정보가 될 수 없다.**
// 플랫폼이 특정 종목·전망을 말하는 순간 그것은 우리 이름으로 나가는 투자권유이고
// (CLAUDE.md §1 법적 경계), 리서처의 리포트와 달리 아무 검수도 거치지 않는다.
// 그래서 화면이 경고만 하는 것이 아니라 **규칙이 막는다** — 경고는 급할 때 안 읽힌다.

// 범위는 **지금 무슨 일을 겪고 있는 사람인가**로 가른다 — 계정 종류가 아니라.
// 점검 안내는 전체에, 정산 지연은 리서처에, 환불 지연은 구매자에게 가야 하고,
// "판정이 멈췄다"는 **지금 카드를 들고 기다리는 사람**에게만 뜻이 있다.
export const NOTICE_AUDIENCES = ['ALL', 'RESEARCHER', 'BUYER', 'HOLDER'] as const;
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];

export function isNoticeAudience(v: string): v is NoticeAudience {
  return (NOTICE_AUDIENCES as readonly string[]).includes(v);
}

export const NOTICE_AUDIENCE_LABEL: Record<NoticeAudience, string> = {
  ALL: '전체',
  RESEARCHER: '리서처만',
  BUYER: '구매자만',
  HOLDER: '검증 중인 카드 보유자',
};

/**
 * 한 사람에게만 보낸 쪽지 — **범위 목록(NOTICE_AUDIENCES)에는 넣지 않는다.**
 *
 * 저 목록은 "공지 보내기 화면에서 고를 수 있는 범위"이고, 개별 쪽지는 거기서 고르는
 * 것이 아니라 **그 사람이 있는 자리에서** 보낸다(신고 내용을 읽다가 그 신고자에게).
 * 목록에 넣으면 공지 화면에 "한 명에게"라는 고를 수 없는 선택지가 생긴다.
 * 다만 보낸 기록은 같은 표(Notice)에 남는다 — "무엇을 언제 누구에게"의 답이
 * 두 곳으로 갈리면 안 된다.
 */
export const NOTICE_DIRECT = 'DIRECT';

/** 보낸 기록 목록이 쓰는 이름 — 개별 쪽지까지 포함해 한 줄로 답한다 */
export function noticeAudienceLabel(v: string): string {
  if (v === NOTICE_DIRECT) return '개별';
  return NOTICE_AUDIENCE_LABEL[v as NoticeAudience] ?? v;
}

/**
 * 신고 건에서 사람에게 말을 걸 때의 **고정 제목** (2026-08-20 사용자 지시).
 *
 * 이 자리에서 보내는 쪽지는 언제나 같은 이유로 나간다 — "이 리포트에 들어온 신고를
 * 우리가 보고 있다". 그때마다 제목을 새로 지으면 사람마다 다른 제목을 받고,
 * 알림함에서 그것이 같은 종류의 소식이라는 사실이 사라진다. 푸시가 종류별로 같은
 * 머리말을 쓰는 것과 같은 이유다.
 *
 * 운영자가 매번 쓰는 것은 **사연**이지 제목이 아니다. 제목 칸을 지우면 쓸 것이
 * 하나로 줄고, 하나로 줄면 실제로 쓰게 된다.
 *
 * **신고자와 리서처가 같은 제목을 쓴다** — 한 사건의 두 당사자이고, 받는 사람이
 * 다르다고 사건이 둘이 되는 것은 아니다.
 */
export const ABUSE_REPLY_TITLE = '리포트 신고 접수 안내';

/**
 * 기각으로 판매가 다시 열렸을 때 리서처가 받는 **고정 제목** (2026-08-20 사용자 지시).
 *
 * 위 제목과 가르는 이유: 이쪽은 접수 안내가 아니라 **결말**이다. 리서처가 기다린
 * 것은 "보고 있다"가 아니라 "다시 팔 수 있다"이고, 알림함 목록에서 열어 보기 전에
 * 그 사실이 읽혀야 한다. 제목은 그대로 푸시 문구가 된다(Notification.title).
 */
export const ABUSE_RESUME_TITLE = '리포트 판매가 재개되었습니다';

/**
 * 기각 = **정해진 양식이 자동으로 나간다** (2026-08-20 사용자 확정).
 *
 * 잠깐 "운영자가 쓴 검토 사유를 본문으로 보내는" 안을 거쳐 여기로 왔다. 양식으로
 * 되돌린 이유가 셋이다:
 *   ① 기각은 **결과가 하나뿐**이다 — "봤고, 문제없었다". 매번 새로 지을 사연이 없다
 *   ② 검토 사유는 운영자가 **자기 기록으로** 쓰는 말이라 남에게 읽히기 위한
 *      문장이 아니다(짧게 끊어 적고, 내부 용어가 섞인다)
 *   ③ 사람마다 다른 문장을 받으면 같은 처분이 다른 처분처럼 보인다
 * 검토 사유는 그대로 `AbuseReport.reviewNote`에 남아 반복 무고 판단의 근거가 된다.
 *
 * 두 사람에게 **다른 문장**이 가는 이유: 리서처가 겪은 일은 "멈췄다가 다시 열렸다"고,
 * 신고자가 알아야 할 것은 "당신이 낸 건을 봤고 이상이 없었다"다. 리서처에게
 * 신고자용 문장을 보내면 자기 판매가 다시 열렸다는 사실이 어디에도 없다.
 */
export const ABUSE_RESUME_BODY =
  '리포트 신고 접수로 인해 일시적으로 판매가 중단되었습니다. 확인 결과 이상이 없는 것으로 판단되어 판매 재개 진행하였습니다.';

/** 기각 시 신고자에게 나가는 고정 본문 — 제목은 `ABUSE_REPLY_TITLE` */
export const ABUSE_REJECTED_REPORTER_BODY =
  '리포트 검토 결과 이상이 없는 것으로 판단되었습니다.';

/**
 * 게시 전 검수의 두 결말 — **리서처가 받는 제목** (2026-08-20 사용자 확정).
 *
 * 제목이 그대로 푸시 문구가 되므로, 알림함 목록에서 **열어 보기 전에 결말이 읽혀야**
 * 한다. 예전 제목은 `게시 승인: {리포트 제목}` 처럼 리포트 이름을 달고 있었는데,
 * 리포트 이름은 본인이 지은 것이라 그 자리에서 알려 줄 새 사실이 아니다 —
 * 알아야 하는 것은 **팔 수 있게 됐는가**뿐이다.
 */
export const REVIEW_APPROVED_TITLE = '리포트 게시가 승인되었습니다.';
export const REVIEW_REJECTED_TITLE = '리포트 게시가 반려되었습니다.';

/**
 * 승인은 **본문까지 고정**이다 — 결과가 하나뿐이라 매번 새로 지을 사연이 없다.
 * (반려는 반대다: 무엇을 왜 고쳐야 하는지가 건마다 달라 운영자가 직접 쓴다)
 */
export const REVIEW_APPROVED_BODY =
  '리포트 검수 결과 이상이 없는 것으로 판단되어, 리포트가 게시되었습니다. 이용에 불편을 드려 죄송합니다.';

/**
 * @근거 설계 알림함 목록에서 한 줄로 읽히는 길이. 제목이 잘리면 무슨 공지인지
 * 열어 봐야 알게 되는데, 공지는 열지 않아도 요점이 전달돼야 한다
 */
export const NOTICE_TITLE_MAX = 60;

/**
 * @근거 설계 문의 답변(2,000자)보다 짧다. 답변은 한 사람의 사정에 맞춰 길어지지만
 * 공지는 전원이 읽는 글이라 길면 아무도 안 읽는다. 긴 설명은 화면을 만들어 링크한다
 */
export const NOTICE_BODY_MAX = 500;

/**
 * @근거 설계 제목만 있고 본문이 한 줄도 없는 공지는 "무슨 일이 있다"까지만 말하고
 * 끝나 문의를 늘린다. 최소한 한 문장은 요구한다
 */
export const NOTICE_BODY_MIN = 10;

/**
 * 공지에 쓸 수 없는 말 — **종목과 수익을 입에 담지 않는다.**
 *
 * 리서처의 리포트는 검수를 거쳐 나가지만 공지는 운영자가 바로 보낸다. 그래서 여기서는
 * 문맥을 판단하지 않고 **어휘 자체를 막는다** — 오탐이 나면 운영자가 문장을 바꾸면
 * 되지만(비용 0), 놓치면 플랫폼 이름으로 나간 투자권유가 되돌아오지 않는다.
 */
const FORBIDDEN = [
  { re: /매수|매도|사세요|파세요|손절|익절/, why: '매매 권유로 읽힙니다' },
  { re: /수익률|수익\s*보장|원금\s*보장|손실\s*보전/, why: '수익·보전 약속으로 읽힙니다' },
  { re: /추천\s*종목|유망|급등|상한가|호재/, why: '종목 추천으로 읽힙니다' },
] as const;

export interface NoticeCheck {
  ok: boolean;
  reason?: string;
}

/** 제목·본문을 함께 본다 — 제목에 종목을 적고 본문을 얌전히 쓰는 우회를 막는다 */
export function checkNoticeText(title: string, body: string): NoticeCheck {
  const t = title.trim();
  const b = body.trim();
  if (t.length === 0) return { ok: false, reason: '제목을 적어 주세요' };
  if (t.length > NOTICE_TITLE_MAX) {
    return { ok: false, reason: `제목은 ${NOTICE_TITLE_MAX}자까지 쓸 수 있습니다` };
  }
  if (b.length < NOTICE_BODY_MIN) {
    return { ok: false, reason: `본문을 ${NOTICE_BODY_MIN}자 이상 적어 주세요` };
  }
  if (b.length > NOTICE_BODY_MAX) {
    return { ok: false, reason: `본문은 ${NOTICE_BODY_MAX}자까지 쓸 수 있습니다` };
  }
  const whole = `${t}\n${b}`;
  for (const f of FORBIDDEN) {
    if (f.re.test(whole)) {
      return {
        ok: false,
        reason: `공지에 쓸 수 없는 표현이 있습니다 — ${f.why}. 공지는 검수를 거치지 않고 플랫폼 이름으로 나갑니다.`,
      };
    }
  }
  return { ok: true };
}
