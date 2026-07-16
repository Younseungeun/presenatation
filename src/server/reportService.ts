import type { PrismaClient } from '@prisma/client';
import type { PrepaymentRatio, Tier } from '@/domain/constants';
import { resolveProvider, toMarketDateString, type ProviderRegistry } from '@/domain/marketData';
import {
  planBaseMode,
  preparePublish,
  PublishValidationError,
  validateCardDraft,
  validateConditions,
  type CardDraft,
} from '@/domain/publishReport';
import { toCardDraft } from './cardMapper';
import { validateListedInstrument } from './instrumentService';
import { researcherSeasonScores } from './scoreService';

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

export async function createDraftReport(
  prisma: PrismaClient,
  input: CreateDraftInput,
  now = new Date(),
) {
  const researcher = await prisma.researcherProfile.findUniqueOrThrow({
    where: { id: input.researcherId },
  });

  // 종목 마스터 검증: 시세 공급자 유니버스 안의 활성 종목만 허용 + 하락 예측 가능 여부
  const instrument = await validateListedInstrument(
    prisma,
    input.card.assetClass,
    input.card.ticker,
    input.card.direction,
  );

  // 초안 단계에서도 형식 오류는 즉시 돌려준다 (게시 시점 재검증은 별도)
  const issues = [
    ...instrument.issues,
    ...validateCardDraft(input.card, now),
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
          // 표시명은 종목 마스터 기준으로 정규화 — 입력값 위조 방지
          assetName: instrument.name ?? input.card.assetName,
          direction: input.card.direction,
          targetType: input.card.targetType,
          targetValue: input.card.targetValue,
          deadline: input.card.deadline,
          confidence: input.card.confidence,
          selfStability: input.card.selfStability,
          selfProfitability: input.card.selfProfitability,
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

  const cardDraft = toCardDraft(card);

  // 게시 시점 재검증: 초안 저장 후 상폐·거래지원종료(active=false)됐을 수 있다
  const instrument = await validateListedInstrument(
    prisma,
    cardDraft.assetClass,
    cardDraft.ticker,
    cardDraft.direction,
  );
  if (instrument.issues.length > 0) {
    throw new PublishValidationError(instrument.issues);
  }

  // 소급 확정 모드(주식 단기 카드)는 시세 조회 없이 컷오프 규칙만 검증된다.
  // 그 외에는 외부 시세 조회(트랜잭션 밖)로 기준가를 게시 시점에 확정한다.
  const plan = planBaseMode(cardDraft.assetClass, cardDraft.deadline, now);
  const basePrice =
    plan.baseMode === 'FIXED_AT_PUBLISH' ? await fetchBasePrice(registry, cardDraft, now) : null;

  // 마이너스 규율(§2.2) 입력: 해당 자산군의 현재 시즌 누적 점수
  const seasonScores = await researcherSeasonScores(prisma, report.researcherId, now);

  // 동시 활성 카드 상한 입력: 같은 자산군에서 게시됐고 아직 판정·철회되지 않은 카드 수
  const activeCardCount = await prisma.predictionCard.count({
    where: {
      assetClass: cardDraft.assetClass,
      withdrawnAt: null,
      judgment: null,
      report: { researcherId: report.researcherId, status: 'PUBLISHED' },
    },
  });

  const snapshot = preparePublish(
    cardDraft,
    {
      priceKrw: report.priceKrw,
      prepaymentRatio: report.prepaymentRatio as PrepaymentRatio,
      tier: report.researcher.tier as Tier,
      promoActive: isPromoActive(report.researcher.promoFeeUntil, now),
      assetClassScore: seasonScores[cardDraft.assetClass],
      activeCardCount,
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
      data: { basePrice: snapshot.basePrice, baseMode: snapshot.baseMode },
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

  // 실시간 현재가를 주는 소스(코인=업비트)는 게시 순간의 가격을 기준가로 쓴다.
  // 이것이 단기(1일) 예측을 허용해도 "이미 실현된 등락 가로채기"가 불가능한 이유다.
  if (provider.getCurrentPrice) {
    return provider.getCurrentPrice(card.ticker);
  }

  // EOD 소스는 직전 거래일 종가 — 이 경우 최소 시한 규칙(주식 7일)이 조작을 막는다
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
