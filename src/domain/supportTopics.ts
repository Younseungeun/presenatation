// 문의 주제 — **자유 입력 창구를 만들지 않는 이유가 이 파일의 전부다.**
//
// 열어 두면 반드시 "이 리포트 사도 될까요?"가 들어온다. 답하면 1:1 투자자문이라
// 라이선스 영역이고(CLAUDE.md §1 법적 경계 — 쌍방향 기능은 영구 금지), 안 답하면
// 창구가 죽는다. 그래서 **주제를 먼저 고르게 하고, 주제 밖으로 나갈 자리를 안 만든다.**
//
// 주제를 가르는 기준은 관리자 화면을 가른 기준과 같다: **이 문의를 끝내려면 무엇을
// 봐야 하는가.** 그래야 도착하는 순간 맞는 화면으로 갈 수 있고, 한 곳에 모았다가
// 다시 흩는 수고가 없다.
//
// 각 주제에는 `selfServe`가 붙는다 — **폼을 열기 전에 먼저 보여주는 답**이다.
// 1인 운영이라 이게 결정적이다: 대부분의 문의는 이미 답이 정해져 있고, 화면이 그것을
// 먼저 말하면 접수 자체가 일어나지 않는다. 답할 필요 없는 문의를 줄이는 유일한 장치다.

export const SUPPORT_TOPICS = [
  'FREEZE_RELEASE',
  'PAYOUT_MISSING',
  'REFUND_MISSING',
  'ACCOUNT_REGISTER',
  'LOGIN',
  'OTHER',
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

/** 문의가 도착할 관리자 화면 — 관리자 콘솔의 탭 키와 같은 말을 쓴다 */
export type SupportDesk = 'security' | 'money' | 'report' | 'status';

export interface SupportTopicSpec {
  topic: SupportTopic;
  label: string;
  /** 목록에서 "이게 내 얘긴가"를 가르는 한 줄 */
  hint: string;
  desk: SupportDesk;
  /** 폼보다 먼저 보여주는 답. 여기서 끝나면 문의가 안 들어온다 */
  selfServe: string;
  /** 무엇을 적어야 우리가 처리할 수 있는지 — 빈 문의를 되묻는 왕복을 없앤다 */
  placeholder: string;
  /**
   * 이 주제는 **경고를 먼저 읽고 체크해야** 입력창이 열린다.
   * 지금은 '기타'만이다 — 투자 질문이 들어올 수 있는 유일한 자리라서.
   */
  gate?: string;
}

export const SUPPORT_TOPIC_SPECS: Record<SupportTopic, SupportTopicSpec> = {
  FREEZE_RELEASE: {
    topic: 'FREEZE_RELEASE',
    label: '정산 동결을 풀고 싶어요',
    hint: '내가 걸어 둔 정산 동결을 해제하려는 경우',
    desk: 'security',
    // 동결은 **본인이 걸고 운영자만 푸는** 비대칭이 장치의 전부다. 그 이유를 여기서
    // 먼저 말해야 "왜 내가 못 푸나"라는 문의가 다시 오지 않는다
    selfServe:
      '정산 동결은 본인이 직접 풀 수 없습니다. 계정을 가로챈 사람도 똑같이 "제가 걸었어요"라고 말하기 때문입니다 — 이 비대칭이 동결을 실제 방어 장치로 만듭니다.\n\n해제는 운영자가 본인 확인을 마친 뒤에만 진행되고, 확인한 내용은 기록으로 남습니다. 아래로 요청을 남겨 주시면 연락드립니다.',
    placeholder:
      '연락 가능한 시간대와, 동결을 걸게 된 상황을 적어 주세요. (예: 계좌를 바꾼 적이 없는데 변경 알림을 받아서 걸었습니다)',
  },
  PAYOUT_MISSING: {
    topic: 'PAYOUT_MISSING',
    label: '정산금이 안 들어왔어요',
    hint: '적중 판정이 났는데 입금이 안 된 경우',
    desk: 'money',
    selfServe:
      '판정 직후 24시간은 정산이 보류됩니다 — 그 사이가 잘못된 판정을 되돌릴 수 있는 시간입니다.\n\n그 뒤에도 안 들어왔다면 세 가지 중 하나입니다: ① 정산 계좌가 아직 검증되지 않음 ② 예금주 이름이 본인 인증 이름과 다름 ③ 정산이 동결되어 있음. 설정 → 정산 계좌에서 상태를 먼저 확인해 주세요.',
    placeholder: '어떤 카드의 정산인지와, 설정 화면에 표시된 계좌 상태를 함께 적어 주세요.',
  },
  REFUND_MISSING: {
    topic: 'REFUND_MISSING',
    label: '환불이 안 왔어요',
    hint: '예측 실패·판정 불가로 환불받아야 하는 경우',
    desk: 'money',
    selfServe:
      '환불은 결제하신 카드로 되돌아갑니다. 저희 쪽 처리가 끝나도 **카드사 반영에 3~5영업일**이 더 걸립니다.\n\n구매 내역에서 그 카드의 상태를 먼저 확인해 주세요. "환불 완료"로 보이는데 아직 입금이 안 됐다면 카드사 반영을 기다리는 중입니다.',
    placeholder: '어떤 리포트인지와, 구매 내역에 표시된 상태를 함께 적어 주세요.',
  },
  ACCOUNT_REGISTER: {
    topic: 'ACCOUNT_REGISTER',
    label: '정산 계좌 등록이 안 돼요',
    hint: '계좌를 넣었는데 검증이 안 되거나 거절되는 경우',
    desk: 'security',
    selfServe:
      '계좌는 **예금주 이름이 본인 인증 이름과 정확히 같아야** 등록됩니다. 가족 명의 계좌는 쓸 수 없습니다 — 정산금이 다른 사람에게 가는 것을 막기 위해서입니다.\n\n또 낯선 기기에서 계좌를 바꾸면 48시간 대기가 붙습니다. 그 기기 화면에 뜬 6자리 번호를 평소 쓰는 기기에서 입력하면 즉시 풀립니다.',
    placeholder: '어느 단계에서 막히는지와 화면에 나온 문구를 그대로 적어 주세요.',
  },
  LOGIN: {
    topic: 'LOGIN',
    label: '로그인이 안 돼요',
    hint: '생체·간편 비밀번호·본인 인증이 안 되는 경우',
    desk: 'security',
    selfServe:
      '간편 비밀번호를 5번 틀리면 잠깁니다. 이때는 **본인 인증으로 다시 설정**할 수 있습니다.\n\n기기를 바꾸셨다면 새 기기에서는 본인 인증부터 하셔야 합니다 — 생체·간편 비밀번호는 기기에 묶여 있어 다른 기기로 옮겨지지 않습니다. 이것이 계정 탈취를 막는 기본 구조입니다.',
    placeholder: '어떤 방법으로 로그인하려 하셨는지와 화면에 나온 문구를 적어 주세요.',
  },
  OTHER: {
    topic: 'OTHER',
    label: '그 밖의 문의',
    hint: '위에 없는 내용',
    // 주제를 못 고른 문의는 대부분 "느리다·안 된다" 류라 **볼 것이 서버 상태**다.
    // 리포트 화면에 두면 글을 읽어야 끝나는 일들 사이에 기계 이야기가 섞인다
    desk: 'status',
    selfServe:
      '위 주제에 해당하지 않는 내용을 남겨 주세요. 서비스 이용 방법, 오류 신고, 제도에 대한 의견 모두 좋습니다.',
    // **이 한 문장이 이 창구 전체를 지킨다.** 막는 것이 아니라 읽게 만드는 장치다 —
    // 읽고 체크한 사람은 투자 질문을 적지 않고, 적더라도 답을 기대하지 않는다
    gate:
      '특정 종목이나 리포트를 사도 되는지 등 **투자 판단에 대한 질문에는 답변드릴 수 없습니다.** 개별 투자 자문은 법으로 금지되어 있어, 그런 내용은 답변 없이 종료됩니다.',
    placeholder: '문의하실 내용을 적어 주세요.',
  },
};

/** 목록에 보이는 순서 — 돈·계정이 위, 기타가 맨 아래 */
export const SUPPORT_TOPIC_ORDER: SupportTopic[] = [
  'FREEZE_RELEASE',
  'ACCOUNT_REGISTER',
  'PAYOUT_MISSING',
  'REFUND_MISSING',
  'LOGIN',
  'OTHER',
];

/**
 * @근거 계약 신고 접수(abuseReportService)의 정황 하한과 같은 값이다. 두 창구가 다른
 * 하한을 쓰면 이용자가 "얼마나 써야 하나"를 화면마다 다시 배워야 한다. 10자는 "환불요"
 * 같은 한 마디를 걸러 되묻는 왕복 한 번을 없애는 선이고, 그보다 올리면 정당한 짧은
 * 문의("로그인 5번 틀려서 잠겼습니다")까지 막힌다.
 */
export const SUPPORT_DETAIL_MIN = 10;
/**
 * @근거 설계 신고(4,000자)의 절반이다. 신고는 정황·인용을 옮겨 적어야 해서 길지만,
 * 문의는 주제가 이미 정해진 상태의 한 문단이라 그만큼 필요하지 않다. 상한을 두는 이유는
 * 저장 공간이 아니라 **운영자가 읽는 시간**이다 — 1인 운영에서 긴 글은 곧 답변 지연이다.
 */
export const SUPPORT_DETAIL_MAX = 2000;
/**
 * 무고성 대량 접수 1차 방어.
 *
 * @근거 설계 신고 하루 한도(3건)보다 넉넉하다. 신고는 남을 제재하는 행위라 조여야 하지만
 * 문의는 **본인이 막혀서 오는 것**이고, 한 사람이 계좌·정산·로그인에 동시에 막히는 일은
 * 실제로 있다. 5건이면 정상 이용자가 닿을 일이 없으면서 스크립트성 도배는 막힌다.
 */
export const SUPPORT_DAILY_LIMIT = 5;

export function isSupportTopic(v: unknown): v is SupportTopic {
  return typeof v === 'string' && (SUPPORT_TOPICS as readonly string[]).includes(v);
}
