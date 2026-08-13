import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import {
  adverseMoveFraction,
  closesOnAdverseMove,
  isSalesWindowOpen,
  remainingFraction,
  suspendsPurchase,
} from '@/domain/salesWindow';
import { magnitudePctToTargetPrice } from '@/domain/scoring';
import { isMarketOpen } from '@/domain/marketHours';
import { isFreeReport } from './freeReportService';
import { fetchCachedQuote } from './priceCache';
import { recordQuote } from './quoteWatchService';
import { researcherConfidenceCap } from './scoreService';

// 구매 → 에스크로 보관. PG(웹 결제) 연동 전까지는 결제 성공을 가정하는 스텁 —
// 실제 연동 시 PG 승인 후 이 함수를 호출하는 구조가 된다 (금액·상태 기록은 동일).
// 토스페이먼츠 테스트 연동(paymentIntentService)도 승인 후 이 함수를 그대로 호출한다.

/**
 * 받는 결제 수단 — **즉시 승인되고, 부분 취소가 되는 것만 받는다.** 조건이 둘이다.
 *
 * ① **즉시 승인.** 무통장입금(가상계좌)은 계좌를 받는 시각과 입금하는 시각이 달라, 그
 *    사이의 시세 변동을 구매자가 뒤집어쓴다 — "결제가 승인되는 순간 광고 폭의 절반
 *    이상"이라는 고지가 거기서 깨진다. 입금 전에 리포트를 열어주면 입금하지 않는 쪽이
 *    이득이기도 하다. 반대로 **실시간 계좌이체·간편결제는 승인 즉시 돈이 빠지므로**
 *    카드와 같은 논리로 안전하다 — 카드가 없는 사람의 길을 막을 이유가 없다.
 *
 * ② **부분 취소.** 실패(MISS)는 선결제분을 빼고 성과 연동분만 돌려주므로 이 상품의
 *    환불은 **부분 취소가 기본**이다. 휴대폰 소액결제·상품권은 당월·전액 등 취소에
 *    제약이 붙어 그 기본 동작이 성립하지 않는다. 즉시 승인되더라도 받지 않는다.
 *
 * (실PG 응답의 차단은 tossPayments.pendingDepositReason / tossMethodCode)
 */
export const ACCEPTED_PAYMENT_METHODS = ['CARD', 'TRANSFER', 'EASY_PAY'] as const;
export type PaymentMethod = (typeof ACCEPTED_PAYMENT_METHODS)[number];

/** 표시용 — VBANK는 이 규칙이 생기기 전 구매 기록에만 남아 있다 */
export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CARD: '카드',
  TRANSFER: '계좌이체',
  EASY_PAY: '간편결제',
  VBANK: '무통장입금(가상계좌)',
};

export interface PaymentInput {
  method: PaymentMethod;
}

/**
 * 요청이 지정한 결제 수단을 검사한다 — **조용히 카드로 바꾸지 않는다.**
 *
 * 모르는 값을 CARD로 눕히면 무통장입금을 고른 사람의 카드가 긁힌다. 안 받는 수단이면
 * 안 받는다고 답하는 것이 맞다. 생략은 허용한다(화면이 더는 보내지 않는다).
 */
export function assertAcceptedPaymentMethod(method: unknown): asserts method is PaymentMethod | undefined {
  if (method == null) return;
  if (!ACCEPTED_PAYMENT_METHODS.includes(method as PaymentMethod)) {
    throw new Error(
      `${PAYMENT_METHOD_LABEL[String(method)] ?? String(method)}은(는) 받지 않는 결제 수단입니다. 예측 카드는 장중 시세에 값이 묶여 있어 즉시 승인되는 수단만 받습니다.`,
    );
  }
}

/**
 * PG 스텁용 모의 결제 정보 — 실제 승인 정보가 없으므로 "모의"임이 표시에 드러나게 만든다.
 * 토스페이먼츠 테스트 연동(paymentIntentService)을 타면 이 대신 실제 승인 응답 요약이 쓰인다.
 * 어느 경우든 카드번호 원문은 저장하지 않는다(마스킹된 표시 문자열만).
 */
function stubPaymentInfo(): string {
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
  predictionCard: {
    deadline: Date;
    /** 규율 상한과 대조한다 — 상한 위의 확신은 팔리면 안 된다 */
    confidence?: number;
    judgment?: { outcome: string } | null;
  } | null;
}

/**
 * 구매·결제 요청 양쪽에서 공유하는 검증 — 한쪽만 고치고 다른 쪽을 깜빡하는 일을 막는다.
 *
 * @param disciplineCap 지금 그 리서처가 그 자산군에서 쓸 수 있는 최대 신뢰도
 *   (server/scoreService.researcherConfidenceCap). 생략하면 검사하지 않는다 —
 *   무료 글·테스트처럼 규율과 무관한 자리를 위한 것이다.
 */
export function assertPurchasable(
  report: PurchasableReport,
  buyerId: string,
  now: Date,
  disciplineCap?: number,
): void {
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
  // **규율 상한은 신규 게시가 아니라 팔리는 확신에 걸린다.**
  // 게시 때만 보면 상한이 내려가기 직전에 낸 ★5 카드가 시한이 끝날 때까지 팔린다 —
  // 장기 카드라면 1년이다. 그동안 처분은 이름만 있고 구매자는 그대로 노출된다.
  // 별점을 소급해서 내리는 방법은 쓰지 않는다: 그 카드는 신고한 확신으로 채점되고
  // 있으므로, 표시만 낮추면 "별점 = 확률 신고"가 깨지고 이미 산 사람이 보는 것도 바뀐다.
  // **가역적 판매 중단**이 맞다 — 적중이 쌓여 상한이 풀리면 다시 팔린다
  // (장중 시세 중단 assertNotSuspendedIntraday와 같은 성격이다).
  const confidence = report.predictionCard?.confidence;
  if (disciplineCap != null && confidence != null && confidence > disciplineCap) {
    throw new Error(
      '리서처의 확신 상한이 내려가 이 카드의 판매가 일시 중단되었습니다 — 신고한 확신이 적중으로 뒷받침되지 않는 동안 그 확신으로는 팔지 않습니다. 적중이 쌓이면 다시 구매할 수 있습니다.',
    );
  }
}

/**
 * 구매 관문에 넘길 규율 상한 — 예측 카드가 없는 글(무료 시황)에는 규율이 없다.
 * 두 관문(구매·결제 요청)이 같은 값을 보도록 여기 한 곳에 둔다.
 */
export async function disciplineCapFor(
  prisma: PrismaClient,
  report: { researcherId: string; predictionCard: { assetClass: string } | null },
  now: Date,
): Promise<number | undefined> {
  if (!report.predictionCard) return undefined;
  return researcherConfidenceCap(
    prisma,
    report.researcherId,
    report.predictionCard.assetClass as AssetClass,
    now,
  );
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
): Promise<PriceGate> {
  if (!card || card.basePrice === null) return 'NO_CARD';
  const assetClass = card.assetClass as AssetClass;
  const { price, live, unchecked } = await fetchCachedQuote(assetClass, card.ticker);
  const open = isMarketOpen(assetClass, now);

  // **장이 열려 있는데 시세를 못 구하면 팔지 않는다 (2026-08-13).**
  //
  // 예전에는 시세가 없으면 그냥 통과시켰다. 판정은 반대로 모르면 멈추는데
  // (JudgmentDeferredError) 판매만 모르면 팔았다 — 그 비대칭이 문제였다.
  // 시세 소스가 장중에 몇 시간 죽으면 가격 방어가 **조용히 꺼진 채로** 계속 팔리고,
  // 그 사이 급락한 종목의 q<0.5 카드가 그대로 나간다. 아무 기록도 남지 않는다.
  //
  // 장이 닫혀 있으면 이야기가 다르다. 닫힌 동안 q는 변하지 않으므로 **마지막 종가가
  // 곧 맞는 값**이고, 여기서 막으면 주말·야간 매출이 통째로 사라진다.
  //
  // `unchecked`(공급자 미설정)는 막지 않는다 — 설정 문제라 판매를 멈춰도 나아지지 않고,
  // 자산군 하나가 통째로 안 팔리는 것을 시세 장애로 오인하면 원인을 못 찾는다.
  if (price === null) {
    if (open && !unchecked) {
      throw new Error(
        '거래소 시세를 확인할 수 없어 구매가 일시 중단되었습니다. 시세가 복구되면 다시 구매할 수 있습니다.',
      );
    }
    return unchecked ? 'UNCHECKED' : 'MARKET_CLOSED';
  }
  // ⚠ 장중의 **낡은 종가**(live=false)는 지금 통과시킨다. 실시간이 없는 공급자에서
  //   전 종목이 막히는 쪽이 더 나쁘다고 봤다 — 대신 STALE_CLOSE로 남겨 분쟁 시
  //   "이 결제가 무엇으로 통과했는지"에 답한다. 문턱을 조일지는 실측 후 결정한다
  const gate: PriceGate = live ? 'LIVE' : 'STALE_CLOSE';

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
  if (magnitudePct <= 0) return gate;
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
  return gate;
}

/**
 * 이 결제의 가격 방어가 **무엇으로** 통과했는지 — 구매 기록에 남는다.
 * 분쟁이 나면 "이 결제가 어떤 근거로 승인됐는가"의 답이 여기 있다.
 */
export type PriceGate =
  /** 실시간 현재가로 q를 쟀다 */
  | 'LIVE'
  /** 일봉 종가로 쟀다 (장이 닫혔거나 실시간을 못 받았다) */
  | 'STALE_CLOSE'
  /** 값이 없는데 장도 닫혀 있었다 — 잴 것도 잴 이유도 없다 */
  | 'MARKET_CLOSED'
  /** 그 자산군의 시세 공급자가 없다 (설정 문제) */
  | 'UNCHECKED'
  /** 잴 카드가 없다 (기준가 미확정 등) */
  | 'NO_CARD';

/** 검증을 통과한 1건 — 이 값만으로 쓰기 연산을 만들 수 있다 */
export interface CheckedPurchase {
  reportId: string;
  priceKrw: number;
  priceGate: PriceGate;
}

/**
 * 구매 직전 검증 전부 — **쓰기는 하지 않는다.**
 *
 * 쓰기와 분리한 이유는 장바구니다. 여러 건을 한 번에 결제할 때 "한 건씩 검증하고
 * 한 건씩 만드는" 방식은 **중간에 실패하면 앞의 것만 만들어진 상태**를 남긴다. 실PG를
 * 붙이면 그게 곧 "합산 금액은 다 냈는데 일부만 받았다"가 된다. 그래서 검증을 전부
 * 끝낸 뒤 쓰기만 한 트랜잭션에 묶을 수 있게 갈라 놓는다.
 *
 * 시세 조회(네트워크)가 여기 들어 있으므로 **이 함수는 트랜잭션 밖에서 돌아야 한다.**
 */
export async function assertPurchasableNow(
  prisma: PrismaClient,
  reportId: string,
  buyerId: string,
  now = new Date(),
): Promise<CheckedPurchase> {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { researcher: true, predictionCard: true },
  });
  assertPurchasable(report, buyerId, now, await disciplineCapFor(prisma, report, now));
  // 가격 보호 — 결제 순간 실시간 시세로 남은 몫(q)을 재고 광고의 절반 밑이면 막는다.
  // 피해자는 구매하는 순간에 생기므로 검사도 그 순간에 한다
  const priceGate = await assertNotSuspendedIntraday(prisma, report.predictionCard, now);

  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: buyerId } });
  if (!buyer.identityVerified) {
    throw new Error('본인 인증 후 구매할 수 있습니다');
  }
  return { reportId, priceKrw: report.priceKrw, priceGate };
}

/**
 * 검증이 끝난 뒤의 쓰기 연산 — **실행하지 않고 돌려준다.** 호출자가 한 트랜잭션에 묶는다.
 *
 * `guard`는 값을 바꾸려는 게 아니라 조건 검사가 목적이다(`data: {}`).
 * assertPurchasableNow는 읽어 둔 값으로 판단하는데 그 사이 시세 조회가 끼어 수백 ms가
 * 흐르고, 그동안 판매 마감 배치가 같은 리포트를 닫을 수 있다. 구매 생성을 리포트 조건에
 * 묶으면 상태가 바뀐 경우 update가 대상을 못 찾아(P2025) 트랜잭션 전체가 되돌아간다.
 * 다시 읽어서 확인하는 방식으로는 "읽고 나서 쓰기까지"의 틈이 그대로 남는다.
 * (게시 상태 전이가 쓰는 것과 같은 패턴 — reportService.finalizePublish)
 */
export function purchaseWriteOps(
  prisma: PrismaClient,
  checked: CheckedPurchase,
  buyerId: string,
  payment: PaymentInput,
  paymentInfoOverride?: string,
  paymentKey?: string,
) {
  return {
    guard: prisma.report.update({
      where: { id: checked.reportId, status: 'PUBLISHED', salesClosedAt: null },
      data: {},
    }),
    // @@unique([reportId, buyerId])가 중복 구매를 차단한다
    create: prisma.purchase.create({
      data: {
        reportId: checked.reportId,
        buyerId,
        amountKrw: checked.priceKrw,
        paymentMethod: payment.method,
        paymentInfo: paymentInfoOverride ?? stubPaymentInfo(),
        paymentKey,
        priceGate: checked.priceGate,
        escrowStatus: 'HELD',
      },
    }),
  };
}

export async function purchaseReport(
  prisma: PrismaClient,
  reportId: string,
  buyerId: string,
  now = new Date(),
  payment: PaymentInput = { method: 'CARD' },
  /** 실PG 승인 응답 요약 — 넘기지 않으면 스텁 모의 정보를 만든다 */
  paymentInfoOverride?: string,
  /**
   * 토스 결제 키 — **환불을 자동으로 실행하려면 이게 있어야 한다.**
   * 정산 콘솔의 PG 취소는 이 키로 그 결제를 찾는다(settlementOpsService.executeRefund).
   * 스텁 구매에는 없고, 없으면 계좌이체로만 환불한다
   */
  paymentKey?: string,
) {
  const checked = await assertPurchasableNow(prisma, reportId, buyerId, now);
  const ops = purchaseWriteOps(prisma, checked, buyerId, payment, paymentInfoOverride, paymentKey);
  const [, purchase] = await prisma.$transaction([ops.guard, ops.create]);
  return purchase;
}
