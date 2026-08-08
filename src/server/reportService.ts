import type { PrismaClient } from '@prisma/client';
import type { PrepaymentRatio, Tier } from '@/domain/constants';
import { resolveProvider, toMarketDateString, type ProviderRegistry } from '@/domain/marketData';
import {
  planBaseMode,
  preparePublish,
  PublishValidationError,
  validateCardDraft,
  validateConditions,
  validateReportText,
  type CardDraft,
} from '@/domain/publishReport';
import {
  findingMessages,
  REPUBLISH_REVIEW_THRESHOLD,
  requiresReviewAfterRejections,
  type RiskCategory,
} from '@/domain/compliance';
import type { ComplianceScreener } from '@/infra/compliance/screener';
import { toCardDraft } from './cardMapper';
import { operatorVerdictWrites, screenAndRecord } from './complianceService';
import { buildNewCardNotificationWrites } from './followService';
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
    ...validateReportText(input),
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
        },
      },
    },
    include: { predictionCard: true },
  });
}

/**
 * 게시 요청: 컴플라이언스 2단 검수를 돌리고 결과에 따라 갈린다.
 * - BLOCK: 게시 실패 (수정 후 재시도)
 * - PASS: 즉시 게시 — 기준가·수수료 고정, 예측 카드 잠금 (되돌릴 수 없음)
 * - WARN·UNAVAILABLE: 게시 보류(PENDING_REVIEW). 운영자가 본문을 검토해 승인해야 판매 시작.
 *   검수로 결론이 안 난 콘텐츠가 판매되는 시간을 0으로 만드는 것이 목적이다.
 */
/**
 * 예측 카드 → 검수 입력 필드.
 * 목표가형의 크기(%)는 기준가가 있어야 산출되는데, 기준가는 게시 시점(또는 판정 시점)에
 * 확정되므로 여기서는 라벨만 넘긴다 — 크기 상한 규칙은 수익률형에만 적용된다.
 */
function cardScreeningFields(card: CardDraft, now: Date) {
  const horizonDays = (card.deadline.getTime() - now.getTime()) / 86_400_000;
  return {
    targetType: card.targetType,
    targetLabel:
      card.targetType === 'TARGET_PRICE' ? String(card.targetValue) : null,
    magnitudePct: card.targetType === 'RETURN_PCT' ? card.targetValue : null,
    horizonDays,
    confidence: card.confidence,
  };
}

export async function publishReport(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  reportId: string,
  researcherId: string,
  now = new Date(),
  /** 컴플라이언스 검수기. null이면 결정적 규칙만 적용된다 */
  screener: ComplianceScreener | null = null,
) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: {
      predictionCard: true,
      researcher: { include: { user: { select: { penName: true, email: true } } } },
    },
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

  // 컴플라이언스 검수: 규제 위반 표현은 게시 자체를 막는다 (§1 법적 경계).
  const compliance = await screenAndRecord(
    prisma,
    reportId,
    {
      title: report.title,
      summary: report.summary,
      content: report.content,
      assetClass: cardDraft.assetClass,
      assetName: cardDraft.assetName,
      direction: cardDraft.direction,
      // 종목 위험(시장경보·상폐 가능성·과소 시총)은 게시 보류를 유발한다
      riskLevel: instrument.riskLevel,
      riskNote: instrument.riskNote,
      delistingRisk: instrument.delistingRisk,
      marketCap: instrument.marketCap,
      // 예측 카드 — 크기의 현실성(규칙)과 본문-카드 정합성(AI)을 함께 보게 한다.
      // 판정은 전적으로 카드로 이뤄지는데 구매자는 본문을 보고 사므로,
      // 카드를 검수 입력에서 빼면 그 둘이 어긋난 리포트를 아무도 못 잡는다.
      ...cardScreeningFields(cardDraft, now),
    },
    screener,
    now,
  );
  // 결정적 규칙이 잡은 명백한 위반만 즉시 거절한다 (오탐이 사실상 없는 표현).
  if (compliance.action === 'REJECT') {
    throw new PublishValidationError(findingMessages(compliance.findings, 'BLOCK'));
  }

  // AI 판정(위반·경고)과 AI 장애는 게시하지 않고 보류한다.
  // AI 판단만으로 게시를 죽이지 않되(오탐 가능), 판매도 시작하지 않고 사람이 결정한다.
  // 기준가·수수료도 여기서 확정하지 않는다 — 승인 시점에 확정해야
  // 보류 기간 동안의 시세 변동이 기준가에 반영되어 정보 이점이 생기지 않는다.
  // 반복 반려된 리포트는 검수를 통과해도 자동 게시하지 않는다 (규칙 탐색 방어).
  const repeatedRejection = requiresReviewAfterRejections(report.rejectionCount);
  if (compliance.action === 'HOLD' || repeatedRejection) {
    const detail =
      compliance.decision === 'UNAVAILABLE'
        ? '자동 검수를 완료하지 못해(AI 일시 장애) 운영자 확인 대기 중입니다.'
        : compliance.action === 'HOLD'
          ? `사유: ${findingMessages(compliance.findings).join(' / ')}`
          : `자동 검수에서는 문제가 발견되지 않았지만, 반려가 ${REPUBLISH_REVIEW_THRESHOLD}회 이상 누적된 리포트라 운영자가 직접 확인합니다.`;
    const held = await prisma.$transaction([
      prisma.report.update({
        where: { id: reportId, status: 'DRAFT' },
        data: { status: 'PENDING_REVIEW' },
      }),
      prisma.notification.create({
        data: {
          userId: report.researcher.userId,
          type: 'COMPLIANCE_PENDING',
          title: `게시 보류 — 검토 중: ${report.title}`,
          body: `${detail} 운영자가 승인하면 판매가 시작되고, 반려되면 사유와 함께 초안으로 돌아갑니다.`,
          link: `/researcher/${report.researcherId}`,
          createdAt: now,
        },
      }),
    ]);
    return { ...held[0], basePrice: null as number | null };
  }

  return finalizePublish(prisma, registry, report.id, 'DRAFT', now);
}

/**
 * 실제 게시 실행 — 기준가 실측·수수료 확정·카드 잠금.
 * 즉시 게시(PASS)와 운영자 승인(PENDING_REVIEW) 두 경로가 공유한다.
 * 승인 경로에서도 이 시점의 시세·컷오프·활성 카드 수로 다시 검증된다.
 */
async function finalizePublish(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  reportId: string,
  expectedStatus: 'DRAFT' | 'PENDING_REVIEW',
  now: Date,
) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    // 필명은 팔로워 알림 문구에 들어간다 ("○○님의 새 예측 카드")
    include: {
      predictionCard: true,
      researcher: { include: { user: { select: { penName: true, email: true } } } },
    },
  });
  const card = report.predictionCard!;
  const cardDraft = toCardDraft(card);

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

  // 팔로워 알림 — 게시와 같은 트랜잭션에 넣어 "게시는 됐는데 알림만 누락"을 막는다
  const followerNotifications = await buildNewCardNotificationWrites(
    prisma,
    {
      researcherId: report.researcherId,
      researcherName: report.researcher.user.penName ?? report.researcher.user.email,
      reportId,
      reportTitle: report.title,
      assetName: card.assetName,
      direction: card.direction,
      sizeLabel:
        card.targetType === 'RETURN_PCT'
          ? `${card.targetValue}%`
          : `목표가 ${card.targetValue.toLocaleString()}`,
    },
    snapshot.publishedAt,
  );

  const [updated] = await prisma.$transaction([
    prisma.report.update({
      // 동시 요청 대비: 진입 상태 조건을 다시 걸어 원자적으로 전이
      where: { id: reportId, status: expectedStatus },
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
    ...followerNotifications,
  ]);

  return { ...updated, basePrice: snapshot.basePrice };
}

/**
 * 운영자 승인 — 보류 리포트를 실제로 게시한다.
 * 기준가·컷오프는 승인 시점 기준으로 확정된다 (보류 중 시세 변동 흡수).
 * 보류 사이 시한이 지났거나 조건이 깨졌으면 preparePublish가 막고, 운영자는 반려하면 된다.
 */
export async function approvePendingReport(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  reportId: string,
  operatorUserId: string,
  now = new Date(),
  /**
   * 지적 자체는 타당했는가. 기본값 false가 곧 "오탐" 라벨이 된다 —
   * 승인의 대다수는 과잉 지적이므로 예외(경미해서 승인)만 표시하게 두는 편이
   * 운영자의 손이 덜 가고, 라벨이 비는 일도 없다 (screeningAccuracy.ts).
   */
  findingsValid = false,
) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { researcher: { select: { userId: true } } },
  });
  if (report.status !== 'PENDING_REVIEW') {
    throw new PublishValidationError([`게시 보류 상태의 리포트만 승인할 수 있습니다 (현재: ${report.status})`]);
  }

  const published = await finalizePublish(prisma, registry, reportId, 'PENDING_REVIEW', now);

  await prisma.$transaction([
    ...(await operatorVerdictWrites(prisma, reportId, 'APPROVED', operatorUserId, now, {
      findingsValid,
    })),
    prisma.notification.create({
      data: {
        userId: report.researcher.userId,
        type: 'COMPLIANCE_PENDING',
        title: `게시 승인: ${report.title}`,
        body: '운영자 검토가 완료되어 판매가 시작되었습니다.',
        link: `/report/${reportId}`,
        createdAt: now,
      },
    }),
  ]);

  return published;
}

/**
 * 운영자 반려 — 보류 리포트를 초안으로 되돌린다.
 * 삭제하지 않는 이유: 리서처가 문구를 고쳐 다시 제출할 수 있어야 하고,
 * 검수 이력(시도 기록)은 어뷰징 탐지 근거로 남아야 하기 때문.
 */
export async function rejectPendingReport(
  prisma: PrismaClient,
  reportId: string,
  operatorUserId: string,
  reason: string,
  now = new Date(),
  /** 운영자가 확인한 실제 위반 유형 (선택) — 비우면 검수 소견을 그대로 인정한 것으로 본다 */
  categories: RiskCategory[] = [],
) {
  const trimmed = reason.trim();
  if (!trimmed) throw new PublishValidationError(['반려 사유는 필수입니다']);

  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { researcher: { select: { userId: true } } },
  });
  if (report.status !== 'PENDING_REVIEW') {
    throw new PublishValidationError([`게시 보류 상태의 리포트만 반려할 수 있습니다 (현재: ${report.status})`]);
  }

  await prisma.$transaction([
    prisma.report.update({
      where: { id: reportId, status: 'PENDING_REVIEW' },
      // 누적 반려 횟수는 다음 제출이 자동 통과할 수 있는지를 가른다 (규칙 탐색 방어)
      data: { status: 'DRAFT', rejectionCount: { increment: 1 } },
    }),
    ...(await operatorVerdictWrites(prisma, reportId, 'REJECTED', operatorUserId, now, {
      reason: trimmed,
      categories,
    })),
    prisma.notification.create({
      data: {
        userId: report.researcher.userId,
        type: 'COMPLIANCE_PENDING',
        title: `게시 반려: ${report.title}`,
        body: `운영자 검토 결과 게시가 반려되었습니다. 사유: ${trimmed} · 초안으로 되돌렸으니 문구를 수정해 다시 게시할 수 있습니다.`,
        link: `/researcher/${report.researcherId}`,
        createdAt: now,
      },
    }),
  ]);

  return { reportId, reason: trimmed };
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
