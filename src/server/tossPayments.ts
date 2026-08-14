// 토스페이먼츠 결제위젯 SDK v2 연동 — 서버 쪽(승인 API 호출)만 다룬다.
// 클라이언트 쪽은 src/app/report/[id]/TossCheckoutButton.tsx.
//
// 아래 클라이언트·시크릿 키는 토스페이먼츠가 개발자 문서에 그대로 박아 공개한
// "문서용 테스트 키"다(전자결제 신청 없이 결제위젯을 체험해보라고 공식 배포하는 값).
// 실제 카드 승인은 절대 일어나지 않고, 금액도 차감되지 않는다.
// https://docs.tosspayments.com/guides/v2/payment-widget/integration
//
// 전자결제 신청을 마치면 개발자센터에서 발급받은 우리 상점 전용 키로 .env를 채워
// 이 기본값을 덮어쓴다. 시크릿 키는 절대 클라이언트로 내려보내지 않는다.
const DOCS_TEST_CLIENT_KEY = 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm';
const DOCS_TEST_SECRET_KEY = 'test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6';

export const TOSS_CLIENT_KEY = process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY ?? DOCS_TEST_CLIENT_KEY;
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY ?? DOCS_TEST_SECRET_KEY;

const CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';
const CANCEL_URL = (paymentKey: string) =>
  `https://api.tosspayments.com/v1/payments/${encodeURIComponent(paymentKey)}/cancel`;

export class TossPaymentError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'TossPaymentError';
  }
}

/** 카드 결제 시 돌아오는 카드 정보 (Payment 객체의 일부만 — 필요한 필드만 다룬다) */
export interface TossCardInfo {
  number: string; // 이미 마스킹된 카드번호 (토스가 마스킹해서 내려준다)
  cardType: string; // 신용 | 체크 | 기프트 | 미확인
}

/** 가상계좌 결제 시 돌아오는 계좌 정보 */
export interface TossVirtualAccountInfo {
  bankCode: string;
  accountNumber: string;
  dueDate: string;
}

export interface TossPaymentResult {
  paymentKey: string;
  orderId: string;
  method: string | null; // "카드" | "가상계좌" | ...
  totalAmount: number;
  status: string;
  approvedAt: string | null;
  card: TossCardInfo | null;
  virtualAccount: TossVirtualAccountInfo | null;
}

/** 돈이 **실제로 들어온** 결제만 이 상태다. 가상계좌는 WAITING_FOR_DEPOSIT으로 돌아온다 */
export const TOSS_SETTLED_STATUS = 'DONE';

/**
 * 입금이 아직 안 끝난 결제인가 — 그렇다면 사유, 끝났으면 null.
 *
 * **승인 API가 200을 돌려줬다고 돈이 들어온 것이 아니다.** 가상계좌를 고르면 토스는
 * 계좌를 발급하고 `status: "WAITING_FOR_DEPOSIT"`으로 **성공 응답**을 준다. 이 구분을
 * 안 하면 입금 전에 리포트가 열린다 — 무통장입금을 고르고 입금하지 않으면 공짜다.
 *
 * 그리고 입금이 끝나도 문제가 남는다. 이 마켓의 상품은 **장중 시세에 묶여 있다.**
 * 월요일에 계좌를 받고 수요일에 넣으면, 그 이틀 사이에 목표까지 남은 폭(q)이 반토막
 * 나도 그대로 팔린다 — "결제가 승인되는 순간 광고 폭의 절반 이상"이라는 고지가 깨진다.
 * 결제 관문(purchaseService.assertNotSuspendedIntraday)은 **누르는 그 순간**을 재도록
 * 만든 장치라, 입금 시각이 따로 있는 수단에는 걸릴 자리가 없다.
 *
 * 그래서 비동기 입금 수단은 받지 않는다. 토스 상점 관리자에서 결제 수단을 꺼도
 * 되지만, **콘솔 설정은 우리 코드가 강제할 수 없다** — 여기서 한 번 더 막는다.
 */
export function pendingDepositReason(result: TossPaymentResult): string | null {
  if (result.virtualAccount) return '가상계좌(무통장입금)';
  if (result.status !== TOSS_SETTLED_STATUS) return `입금 대기 상태(${result.status})`;
  return null;
}

/**
 * 토스가 돌려준 결제 수단 이름을 우리 코드로 옮긴다 — **모르는 수단은 null.**
 *
 * 즉시 승인되는 수단이라고 다 받을 수 있는 건 아니다. 이 상품의 환불은 실패(MISS) 시
 * 성과 연동분만 돌려주는 **부분 취소가 기본**인데, 휴대폰 소액결제·상품권은 당월·전액
 * 같은 제약이 붙어 그 기본 동작이 성립하지 않는다. 승인은 즉시라도 받지 않는다.
 *
 * 실제로 무엇으로 결제됐는지를 구매 기록에 남기는 것이 목적이기도 하다. 전부 'CARD'로
 * 적으면 나중에 수단별로 갈라야 할 때 근거가 없다.
 *
 * **실시간 계좌이체는 환불 계좌를 따로 받지 않아도 된다.** 가상계좌는 입금자가 누구인지
 * 금융망을 거쳐 알 수 없어 `refundReceiveAccount`가 필요하지만, 계좌이체는 돈이 빠져나간
 * 원천 계좌가 이미 연결돼 있어 금액만 넣어 취소하면 그 계좌로 돌아간다. 카드와 같은
 * 로직으로 자동 환불된다 — 구매 흐름에 계좌 입력을 더할 필요가 없다.
 */
export function tossMethodCode(result: TossPaymentResult): 'CARD' | 'TRANSFER' | 'EASY_PAY' | null {
  switch (result.method) {
    case '카드':
      return 'CARD';
    case '계좌이체':
      return 'TRANSFER';
    case '간편결제':
      return 'EASY_PAY';
    default:
      // 휴대폰·상품권·가상계좌 등. 카드 정보가 실려 오면 카드로 본다(간편결제의 카드 결제)
      return result.card ? 'CARD' : null;
  }
}

/**
 * 결제 승인 API 호출 — 인증만 끝난 결제(IN_PROGRESS)를 최종 승인해 완료(DONE) 상태로 만든다.
 * 여기서 실제로(테스트 환경에서는 가상으로) 금액이 차감된다.
 *
 * **멱등키가 반드시 붙어야 하는 자리다.** 위험한 창은 "승인 호출 → 우리가 CONFIRMED를
 * 적기까지"의 사이다. 여기서 응답을 못 받으면(타임아웃·연결 끊김) **돈은 빠졌는데
 * 우리는 모르는** 상태가 되고, 사용자가 새로고침해 다시 승인을 부른다.
 *
 * 키가 없으면 토스는 두 번째 호출에 `ALREADY_PROCESSED_PAYMENT` **오류**를 준다.
 * 돈이 두 번 빠지지는 않지만 결과가 더 나쁠 수 있다 — 우리 코드는 그 오류를 승인 실패로
 * 읽어 던지고, **구매 행은 안 만들어지며 의도는 PENDING에 남아 아무도 그 건을 못 찾는다.**
 * 키가 있으면 같은 키의 재요청에 **원래의 성공 응답**이 그대로 오므로, 재시도가 오류가
 * 아니라 정상 완료가 된다 — 사용자는 자기가 낸 돈에 해당하는 리포트를 받는다.
 *
 * 키는 `orderId`다: 의도 하나 = 승인 하나라 자연스러운 단위이고, 결제창을 다시 열면
 * 새 의도(새 orderId)가 생기므로 **다른 결제가 같은 키를 쓰는 일이 없다.**
 */
export async function confirmTossPayment(params: {
  paymentKey: string;
  orderId: string;
  amount: number;
}): Promise<TossPaymentResult> {
  const auth = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');

  const res = await fetch(CONFIRM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': params.orderId,
    },
    body: JSON.stringify(params),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new TossPaymentError(body.message ?? '결제 승인에 실패했습니다', body.code);
  }
  return body as TossPaymentResult;
}

/**
 * 결제 취소(승인 취소) API — 승인된 결제를 되돌린다. 금액을 주면 부분 취소다.
 *
 * 쓰이는 자리가 셋이다:
 *  ① **보상 트랜잭션** — PG 승인은 됐는데 구매 생성이 실패했을 때 즉시 되돌린다
 *     (server/paymentIntentService). 이게 없으면 "돈은 빠졌는데 리포트가 없다"가 남는다
 *  ② **비동기 입금 수단 거절** — 가상계좌가 발급됐을 때 그 자리에서 닫는다.
 *     입금 전이라 환불 계좌(refundReceiveAccount)가 필요 없다
 *  ③ **판정 실패 시의 구매자 환불** (settlementOpsService.executeRefund).
 *     실패(MISS)는 성과 연동분만 돌려주므로 **부분 취소**가 기본이다
 *
 * **이 호출이 실패하면 조용히 넘어가면 안 된다.** 호출자가 REQUIRES_MANUAL_VOID로
 * 남기거나 던져서 사람이 처리하게 해야 한다 — 실패를 삼키면 그 돈은 아무도 모르게 사라진다.
 */
export async function cancelTossPayment(params: {
  paymentKey: string;
  /** 취소 사유 — 토스 콘솔·정산 내역에 그대로 남는다 */
  cancelReason: string;
  /** 부분 취소액(원). 생략하면 전액 취소 */
  cancelAmount?: number;
  /**
   * 멱등키 — **같은 키로 두 번 불러도 한 번만 취소된다.**
   *
   * 환불은 재시도되는 동작이다: 네트워크가 끊겨 응답을 못 받으면 실제로 취소가 됐는지
   * 알 수 없고, 운영자는 미실행으로 보이는 건을 다시 누른다. 키가 없으면 그때 두 번
   * 빠진다. 정산 건 id를 키로 쓰면 그 정산의 환불은 몇 번을 눌러도 한 번이다.
   */
  idempotencyKey?: string;
}): Promise<TossPaymentResult> {
  const auth = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
  };
  if (params.idempotencyKey) headers['Idempotency-Key'] = params.idempotencyKey;

  const res = await fetch(CANCEL_URL(params.paymentKey), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      cancelReason: params.cancelReason,
      ...(params.cancelAmount != null ? { cancelAmount: params.cancelAmount } : {}),
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new TossPaymentError(body.message ?? '결제 취소에 실패했습니다', body.code);
  }
  return body as TossPaymentResult;
}

/** 승인 응답을 구매 내역에 남길 표시용 문자열로 요약 — 카드번호 등 원문은 만들지 않는다(토스가 이미 마스킹한 값만 사용) */
export function describeTossPayment(result: TossPaymentResult): string {
  if (result.card) {
    return `${result.card.cardType} 카드 ${result.card.number} (토스페이먼츠 테스트 승인)`;
  }
  if (result.virtualAccount) {
    const due = new Date(result.virtualAccount.dueDate).toLocaleDateString('ko-KR');
    return `가상계좌 ${result.virtualAccount.accountNumber} (은행코드 ${result.virtualAccount.bankCode}, 입금기한 ${due}, 토스페이먼츠 테스트)`;
  }
  return `${result.method ?? '알 수 없음'} (토스페이먼츠 테스트 승인)`;
}
