import type { PrismaClient } from '@prisma/client';
import type { Direction } from '@/domain/constants';
import {
  adverseMoveFraction,
  closesOnAdverseMove,
  isSalesWindowOpen,
  remainingFraction,
  suspendsPurchase,
} from '@/domain/salesWindow';
import { magnitudePctToTargetPrice } from '@/domain/scoring';
import { isFreeReport } from './freeReportService';
import { fetchCachedPrice } from './priceCache';
import { recordQuote } from './quoteWatchService';

// 구매 → 에스크로 보관. PG(웹 결제) 연동 전까지는 결제 성공을 가정하는 스텁 —
// 실제 연동 시 PG 승인 후 이 함수를 호출하는 구조가 된다 (금액·상태 기록은 동일).
// 토스페이먼츠 테스트 연동(paymentIntentService)도 승인 후 이 함수를 그대로 호출한다.

export type PaymentMethod = 'CARD' | 'VBANK';

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CARD: '카드',
  VBANK: '무통장입금(가상계좌)',
};

export interface PaymentInput {
  method: PaymentMethod;
}

/**
 * PG 스텁용 모의 결제 정보 — 실제 승인 정보가 없으므로 "모의"임이 표시에 드러나게 만든다.
 * 토스페이먼츠 테스트 연동(paymentIntentService)을 타면 이 대신 실제 승인 응답 요약이 쓰인다.
 * 어느 경우든 카드번호 원문은 저장하지 않는다(마스킹된 표시 문자열만).
 */
function stubPaymentInfo(method: PaymentMethod): string {
  if (method === 'VBANK') {
    const acct = `562-${100000 + Math.floor(Math.random() * 900000)}-01-999`;
    return `신한은행 ${acct} (모의 가상계좌)`;
  }
  const last4 = String(1000 + Math.floor(Math.random() * 9000));
  return `개인 신용카드 ****-${last4} (모의 승인)`;
}

interface PurchasableReport {
  status: string;
  priceKrw: number;
  salesClosedAt?: Date | null;
  /** 시간 규칙(판매 기간)을 그 자리에서 계산하기 위해 필요하다 — 아래 주석 참고 */
  publishedAt?: Date | null;
  researcher: { userId: string };
  /** judgment: 조기 판정으로 시한 전에 결과가 나올 수 있어 반드시 함께 본다 */
  predictionCard: { deadline: Date; judgment?: { outcome: string } | null } | null;
}

/** 구매·결제 요청 양쪽에서 공유하는 검증 — 한쪽만 고치고 다른 쪽을 깜빡하는 일을 막는다 */
export function assertPurchasable(report: PurchasableReport, buyerId: string, now: Date): void {
  if (report.status !== 'PUBLISHED') {
    throw new Error(`판매 중인 리포트가 아닙니다 (현재: ${report.status})`);
  }
  // 무료 글(예측 카드 없는 시황)은 결제 대상이 아니다 — 누구나 바로 읽는다
  if (isFreeReport(report)) {
    throw new Error('무료 리포트는 결제 없이 열람할 수 있습니다');
  }
  if (report.researcher.userId === buyerId) {
    throw new Error('자기 리포트는 구매할 수 없습니다 (자기 구매 조작 방지)');
  }
  // 판매 마감(시간 규칙·리서처 단축) — 확정 상태라 재개되지 않는다
  if (report.salesClosedAt) {
    throw new Error('판매가 마감된 리포트입니다');
  }
  // **판정이 끝난 카드는 결과를 아는 사람이 사게 된다.**
  // 조기 판정이 생기기 전에는 이 검사가 필요 없었다 — 판정은 시한 이후에만 일어나므로
  // 아래 "시한이 지났나"가 "이미 판정됐나"를 함께 막아 줬다. 조기 판정이 그 전제를
  // 깨뜨렸으므로(시한이 남았는데 결과가 나온 카드) 판정 여부를 직접 본다.
  if (report.predictionCard?.judgment) {
    throw new Error('판정이 끝난 리포트는 구매할 수 없습니다');
  }
  // 시한이 지난 카드는 곧 판정되므로 신규 구매 차단 (결과를 보고 사는 것 방지).
  // **판매 기간보다 먼저 본다** — 판매 기간은 시한보다 항상 먼저 끝나므로 시한이 지난
  // 카드는 판매 기간도 지나 있다. 그때 "판매 기간이 끝났다"고 답하면 덜 말한 것이 된다
  if (report.predictionCard && report.predictionCard.deadline <= now) {
    throw new Error('검증 시한이 지난 리포트는 구매할 수 없습니다');
  }
  // **시간 규칙은 플래그를 기다리지 않는다.**
  // salesClosedAt을 쓰는 것은 하루 1회 도는 배치(batch:salesclose)라, 이 검사가 없으면
  // 판매 기간이 끝난 카드가 다음 배치까지 계속 팔린다. 시간 규칙은 게시일·시한만으로
  // 완전히 결정되므로 여기서 바로 계산하는 것이 맞다.
  if (!isSalesWindowOpen(report.publishedAt, report.predictionCard?.deadline, now)) {
    throw new Error('판매 기간이 끝난 리포트입니다');
  }
}

interface IntradayCard {
  assetClass: string;
  ticker: string;
  direction: string;
  targetType: string;
  targetValue: number;
  basePrice: number | null;
}

/**
 * 결제 순간의 판매 중단 검사 (2026-08-10 재설계) — **가역**이다.
 *
 * 결제 버튼을 누르는 그 순간의 실시간 시세로
 *   q = 남은 수익률 ÷ 광고한 목표 수익률
 * 을 재고, q < 1/2 이면 이 결제만 막는다. 시세가 구간으로 돌아오면 다시 팔린다 —
 * 영구 마감이 아니므로 순간 꼬리(wick)로 남의 판매를 죽이는 조작이 성립하지 않는다.
 *
 * 이것이 "구매 승인 = 광고 폭의 절반 이상 보장"이라는 고지를 참으로 만드는 집행이다.
 * 기준가·시세가 없으면 판단하지 않는다 (막는 쪽으로 지어내지 않는다).
 */
async function assertNotSuspendedIntraday(
  prisma: PrismaClient,
  card: IntradayCard | null,
  now: Date,
): Promise<void> {
  if (!card || card.basePrice === null) return;
  const price = await fetchCachedPrice(card.assetClass, card.ticker);
  if (price === null) return;

  // **이 호출이 감시 대상을 발굴한다** (2026-08-12 사용자 확정).
  // 문턱에서 먼 종목은 장중에 갱신하지 않으므로, 그 사이 문턱으로 다가온 것을 아무도
  // 모른다. 그런데 "사려는 사람"이 누르는 이 순간이 곧 그 종목의 실시간 관측이다 —
  // 여기서 얻은 시세를 스냅샷에 남기고, 문턱 근처면 그 자리에서 감시로 편입한다.
  // 그러면 다음 사람부터는 목록 단계에서 이미 걸러진다.
  // 실패해도 결제는 계속한다 — 감시는 부가 기능이고 이 함수의 본업은 차단이다
  try {
    await recordQuote(prisma, card.assetClass, card.ticker, price, 'gate', now);
  } catch {
    /* 스냅샷 기록 실패가 결제를 막지 않는다 */
  }
  const targetPrice =
    card.targetType === 'TARGET_PRICE'
      ? card.targetValue
      : magnitudePctToTargetPrice(card.basePrice, card.direction as Direction, card.targetValue);
  // 광고한 목표 수익률(%) — 목표가형은 기준가 대비로 환산한다
  const magnitudePct =
    card.targetType === 'RETURN_PCT'
      ? card.targetValue
      : (Math.abs(card.targetValue - card.basePrice) / card.basePrice) * 100;
  if (magnitudePct <= 0) return;
  const q = remainingFraction(card.direction as Direction, price, targetPrice, magnitudePct);
  if (suspendsPurchase(q)) {
    throw new Error(
      '목표까지 남은 폭이 광고한 폭의 절반 밑이라 판매가 일시 중단되었습니다. 시세가 돌아오면 다시 구매할 수 있습니다.',
    );
  }

  // 역방향 보호 — 기준가에서 목표 폭만큼 반대로 간 상태에서는 팔지 않는다.
  // **여기서는 막기만 하고 마감을 기록하지 않는다**: 영구 마감은 일봉 종가로만
  // 판정한다(salesCloseService). 장중 꼬리 한 번으로 남의 판매를 영구히 죽이는
  // 조작을 막으면서도, 그 순간의 구매자는 보호한다
  const adverse = adverseMoveFraction(
    card.direction as Direction,
    card.basePrice,
    price,
    magnitudePct,
  );
  if (closesOnAdverseMove(adverse)) {
    throw new Error(
      '예측과 반대로 목표 폭만큼 움직여 판매가 중단되었습니다. 오늘 종가로도 같은 상태면 판매가 마감됩니다.',
    );
  }
}

export async function purchaseReport(
  prisma: PrismaClient,
  reportId: string,
  buyerId: string,
  now = new Date(),
  payment: PaymentInput = { method: 'CARD' },
  /** 실PG 승인 응답 요약 — 넘기지 않으면 스텁 모의 정보를 만든다 */
  paymentInfoOverride?: string,
) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { researcher: true, predictionCard: true },
  });
  assertPurchasable(report, buyerId, now);
  // 가격 보호 — 결제 순간 실시간 시세로 남은 몫(q)을 재고 광고의 절반 밑이면 막는다.
  // 피해자는 구매하는 순간에 생기므로 검사도 그 순간에 한다
  await assertNotSuspendedIntraday(prisma, report.predictionCard, now);

  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: buyerId } });
  if (!buyer.identityVerified) {
    throw new Error('본인 인증 후 구매할 수 있습니다');
  }

  // **확인과 쓰기를 한 덩어리로 묶는다.**
  //
  // 위의 assertPurchasable은 이 함수가 시작할 때 읽어 둔 값으로 판단한다. 그런데 그
  // 사이에 시세 조회(assertNotSuspendedIntraday)가 끼어 수백 ms가 흐르고, 그동안
  // 판매 마감 배치가 같은 리포트를 닫을 수 있다. 그러면 서버는 이미 낡아버린 값을 보고
  // "판매 중"이라 판단해 구매를 만든다.
  //
  // 그래서 구매 생성을 **리포트 조건에 묶어** 한 트랜잭션으로 실행한다:
  // 그 사이에 상태가 바뀌었으면 update가 대상을 못 찾아(P2025) 트랜잭션 전체가
  // 되돌아가고 구매는 만들어지지 않는다. 다시 읽어서 확인하는 방식으로는
  // "읽고 나서 쓰기까지"의 틈이 그대로 남는다.
  //
  // data: {} — 값을 바꾸려는 게 아니라 조건 검사가 목적이다.
  // (게시 상태 전이가 쓰는 것과 같은 패턴 — reportService.finalizePublish)
  const [, purchase] = await prisma.$transaction([
    prisma.report.update({
      where: { id: reportId, status: 'PUBLISHED', salesClosedAt: null },
      data: {},
    }),
    // @@unique([reportId, buyerId])가 중복 구매를 차단한다
    prisma.purchase.create({
      data: {
        reportId,
        buyerId,
        amountKrw: report.priceKrw,
        paymentMethod: payment.method,
        paymentInfo: paymentInfoOverride ?? stubPaymentInfo(payment.method),
        escrowStatus: 'HELD',
      },
    }),
  ]);
  return purchase;
}
