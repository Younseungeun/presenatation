import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import { cardProfitabilityLevel } from '@/domain/profitability';
import { remainingReturnPct, suspendsIntraday } from '@/domain/salesWindow';
import { magnitudePctToTargetPrice } from '@/domain/scoring';
import { isFreeReport } from './freeReportService';
import { fetchCachedPrice } from './priceCache';

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
  researcher: { userId: string };
  predictionCard: { deadline: Date } | null;
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
  // 판매 마감(시간 규칙 또는 구간 이탈 종가) — 확정 상태라 재개되지 않는다
  if (report.salesClosedAt) {
    throw new Error('판매가 마감된 리포트입니다');
  }
  // 시한이 지난 카드는 곧 판정되므로 신규 구매 차단 (결과를 보고 사는 것 방지)
  if (report.predictionCard && report.predictionCard.deadline <= now) {
    throw new Error('검증 시한이 지난 리포트는 구매할 수 없습니다');
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

/** 장중 결제 중단 검사 — 기준가·시세가 없으면 판단하지 않는다 (막는 쪽으로 지어내지 않는다) */
async function assertNotSuspendedIntraday(card: IntradayCard | null): Promise<void> {
  if (!card || card.basePrice === null) return;
  const level = cardProfitabilityLevel(card);
  if (level === null) return;
  const price = await fetchCachedPrice(card.assetClass, card.ticker);
  if (price === null) return;
  const targetPrice =
    card.targetType === 'TARGET_PRICE'
      ? card.targetValue
      : magnitudePctToTargetPrice(card.basePrice, card.direction as Direction, card.targetValue);
  const remaining = remainingReturnPct(card.direction as Direction, price, targetPrice);
  if (suspendsIntraday(card.assetClass as AssetClass, level, remaining)) {
    throw new Error(
      '목표까지 남은 폭이 보장선 아래로 내려가 판매가 일시 중단되었습니다. 오늘 종가 기준으로 마감 여부가 확정됩니다.',
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
  // 장중 보호 — 종가 배치가 아직 안 닫았어도 결제 순간 잔여가 중단선(구간 바닥×1/2)
  // 밑이면 막는다. 피해자는 구매하는 순간에 생기므로 검사도 그 순간에 한다.
  // 시세가 없으면(장애·미지원 자산군) 그냥 통과 — 종가 규칙이 다음 회차에 지킨다
  await assertNotSuspendedIntraday(report.predictionCard);

  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: buyerId } });
  if (!buyer.identityVerified) {
    throw new Error('본인 인증 후 구매할 수 있습니다');
  }

  // @@unique([reportId, buyerId])가 중복 구매를 차단한다
  return prisma.purchase.create({
    data: {
      reportId,
      buyerId,
      amountKrw: report.priceKrw,
      paymentMethod: payment.method,
      paymentInfo: paymentInfoOverride ?? stubPaymentInfo(payment.method),
      escrowStatus: 'HELD',
    },
  });
}
