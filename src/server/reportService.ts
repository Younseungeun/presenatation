import type { PrismaClient } from '@prisma/client';
import type { PrepaymentRatio, Tier } from '@/domain/constants';
import { resolveProvider, toMarketDateString, type ProviderRegistry } from '@/domain/marketData';
import {
  preparePublish,
  PublishValidationError,
  validateCardDraft,
  validateConditions,
  type CardDraft,
} from '@/domain/publishReport';

// 리포트 생명주기: DRAFT → PUBLISHED → (철회 시) CLOSED
// 게시 시점에 수수료·기준가가 고정되고 예측 카드가 잠긴다.
// 잠금은 "수정 API를 만들지 않는 것"이 아니라 서비스 레이어 규칙으로 강제한다.

/** 기준가 확정에 사용할 직전 거래일 탐색 범위 (연휴 대비) */
const BASE_PRICE_LOOKBACK_DAYS = 14;

export interface CreateDraftInput {
  researcherId: string;
  title: string;
  summary: string;
  content: string;
  priceKrw: number;
  prepaymentRatio: PrepaymentRatio;
  card: CardDraft;
}

export async function createDraftReport(prisma: PrismaClient, input: CreateDraftInput) {
  const researcher = await prisma.researcherProfile.findUniqueOrThrow({
    where: { id: input.researcherId },
  });

  // 초안 단계에서도 형식 오류는 즉시 돌려준다 (게시 시점 재검증은 별도)
  const issues = [
    ...validateCardDraft(input.card),
    ...validateConditions({
      priceKrw: input.priceKrw,
      prepaymentRatio: input.prepaymentRatio,
      tier: researcher.tier as Tier,
      promoActive: isPromoActive(researcher.promoFeeUntil),
    }),
  ];
  if (issues.length > 0) {
    throw new PublishValidationError(issues);
  }

  return prisma.report.create({
    data: {
      researcherId: input.researcherId,
      title: input.title,
      summary: input.summary,
      content: input.content,
      priceKrw: input.priceKrw,
      prepaymentRatio: input.prepaymentRatio,
      status: 'DRAFT',
      predictionCard: {
        create: {
          assetClass: input.card.assetClass,
          ticker: input.card.ticker,
          currency: input.card.assetClass === 'US_EQUITY' ? 'USD' : 'KRW',
          assetName: input.card.assetName,
          direction: input.card.direction,
          targetType: input.card.targetType,
          targetValue: input.card.targetValue,
          deadline: input.card.deadline,
          confidence: input.card.confidence ?? null,
        },
      },
    },
    include: { predictionCard: true },
  });
}

/**
 * 게시: 기준가를 시세 공급자에서 실측(직전 거래일 종가)해 고정하고,
 * 수수료를 확정하며, 예측 카드를 잠근다. 이후 카드 수정·삭제는 불가능하다.
 */
export async function publishReport(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  reportId: string,
  researcherId: string,
  now = new Date(),
) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { predictionCard: true, researcher: true },
  });

  if (report.researcherId !== researcherId) {
    throw new Error('본인의 리포트만 게시할 수 있습니다');
  }
  if (report.status !== 'DRAFT') {
    throw new Error(`초안 상태의 리포트만 게시할 수 있습니다 (현재: ${report.status})`);
  }
  const card = report.predictionCard;
  if (!card) {
    throw new Error('예측 카드가 없는 리포트는 게시할 수 없습니다');
  }

  const cardDraft: CardDraft = {
    assetClass: card.assetClass as CardDraft['assetClass'],
    ticker: card.ticker,
    assetName: card.assetName,
    direction: card.direction as CardDraft['direction'],
    targetType: card.targetType as CardDraft['targetType'],
    targetValue: card.targetValue,
    deadline: card.deadline,
    confidence: card.confidence ?? undefined,
  };

  // 외부 시세 조회는 트랜잭션 밖에서 — 직전 거래일 종가를 기준가로 확정
  const basePrice = await fetchBasePrice(registry, cardDraft, now);

  const snapshot = preparePublish(
    cardDraft,
    {
      priceKrw: report.priceKrw,
      prepaymentRatio: report.prepaymentRatio as PrepaymentRatio,
      tier: report.researcher.tier as Tier,
      promoActive: isPromoActive(report.researcher.promoFeeUntil, now),
    },
    basePrice,
    now,
  );

  const [updated] = await prisma.$transaction([
    prisma.report.update({
      // 동시 게시 요청 대비: DRAFT 조건을 다시 걸어 원자적으로 전이
      where: { id: reportId, status: 'DRAFT' },
      data: {
        status: 'PUBLISHED',
        publishedAt: snapshot.publishedAt,
        feeRateBp: snapshot.feeRateBp,
      },
    }),
    prisma.predictionCard.update({
      where: { id: card.id },
      data: { basePrice: snapshot.basePrice },
    }),
  ]);

  return { ...updated, basePrice: snapshot.basePrice };
}

/**
 * 철회: 카드 기록은 그대로 남기고(withdrawnAt), 리포트를 판매 중지한다.
 * 판정 시 UNDECIDABLE(WITHDRAWN) → 전액 환불로 이어진다 (judgment.ts).
 */
export async function withdrawPredictionCard(
  prisma: PrismaClient,
  reportId: string,
  researcherId: string,
  now = new Date(),
) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { predictionCard: { include: { judgment: true } } },
  });

  if (report.researcherId !== researcherId) {
    throw new Error('본인의 리포트만 철회할 수 있습니다');
  }
  if (report.status !== 'PUBLISHED') {
    throw new Error(`게시된 리포트만 철회할 수 있습니다 (현재: ${report.status})`);
  }
  const card = report.predictionCard;
  if (!card) throw new Error('예측 카드가 없습니다');
  if (card.withdrawnAt) throw new Error('이미 철회된 카드입니다');
  if (card.judgment) throw new Error('판정이 완료된 카드는 철회할 수 없습니다');

  await prisma.$transaction([
    prisma.predictionCard.update({ where: { id: card.id }, data: { withdrawnAt: now } }),
    prisma.report.update({ where: { id: reportId }, data: { status: 'CLOSED' } }),
  ]);
}

function isPromoActive(promoFeeUntil: Date | null, now = new Date()): boolean {
  return promoFeeUntil !== null && promoFeeUntil > now;
}

async function fetchBasePrice(
  registry: ProviderRegistry,
  card: CardDraft,
  now: Date,
): Promise<number> {
  const provider = resolveProvider(registry, card.assetClass);
  const to = toMarketDateString(now, card.assetClass);
  const from = toMarketDateString(
    new Date(now.getTime() - BASE_PRICE_LOOKBACK_DAYS * 86_400_000),
    card.assetClass,
  );
  const quotes = await provider.getDailyQuotes(card.ticker, from, to);
  if (quotes.length === 0) {
    throw new Error(
      `${card.ticker}: 최근 ${BASE_PRICE_LOOKBACK_DAYS}일 시세가 없어 기준가를 확정할 수 없습니다 (티커 오류 또는 거래정지 가능)`,
    );
  }
  return quotes[quotes.length - 1].close;
}
