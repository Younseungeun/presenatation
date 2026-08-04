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

/**
 * 결제 승인 API 호출 — 인증만 끝난 결제(IN_PROGRESS)를 최종 승인해 완료(DONE) 상태로 만든다.
 * 여기서 실제로(테스트 환경에서는 가상으로) 금액이 차감된다.
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
    },
    body: JSON.stringify(params),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new TossPaymentError(body.message ?? '결제 승인에 실패했습니다', body.code);
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
