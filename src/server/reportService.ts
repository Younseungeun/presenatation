import type { PrismaClient } from '@prisma/client';
import type { BaseMode, PrepaymentRatio, Tier } from '@/domain/constants';
import { resolveProvider, toMarketDateString, type ProviderRegistry } from '@/domain/marketData';
import {
  LONG_HORIZON_DAYS,
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
import {
  REVIEW_APPROVED_BODY,
  REVIEW_APPROVED_TITLE,
  REVIEW_REJECTED_TITLE,
} from '@/domain/notice';
import type { ComplianceScreener } from '@/infra/compliance/screener';
import { toCardDraft } from './cardMapper';
import { countUnjudgeableCards } from './compensationService';
import { operatorVerdictWrites, screenAndRecord } from './complianceService';
import { buildNewCardNotificationWrites } from './followService';
import { validateListedInstrument } from './instrumentService';
import { captureBaseAnchor } from './corporateActionService';
import { getInstrumentSigmaResult } from './instrumentSigma';

import { buildJudgmentWrites } from './judgmentWriter';
import { researcherSeasonTotals } from './scoreService';

// 리포트 생명주기: DRAFT → PUBLISHED → (철회 시) CLOSED
// 게시 시점에 수수료·기준가가 고정되고 예측 카드가 잠긴다.
// 잠금은 "수정 API를 만들지 않는 것"이 아니라 서비스 레이어 규칙으로 강제한다.

/**
 * σ를 잴 수 없는 종목의 게시 거절 문구 — 관문과 작성 화면이 같은 문장을 쓴다.
 *
 * **왜 이 문장인가**: 리서처에게 "안 됩니다"만 말하면 규칙이 임의로 보인다. 막는 이유가
 * 종목의 상태이고 **언제 풀리는지가 정해져 있다**는 것을 같이 말해야 기다릴 수 있다.
 */
export const INSUFFICIENT_MARKET_DATA =
  '이 종목은 아직 변동성을 잴 수 있을 만큼 거래 이력이 없습니다 (최소 20거래일). ' +
  '예측 크기 하한과 점수 기준이 종목 변동성에서 나오므로, 그 값을 못 구하면 카드를 게시할 수 없습니다. ' +
  '거래일이 쌓이면 자동으로 열립니다.';

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
  //
  // 크기 하한이 종목 변동성으로 정해지므로 σ를 함께 넘긴다. **캐시된 값을 쓴다** —
  // 작성 화면이 종목을 고르는 순간 /api/instruments/sigma로 채워 둔 바로 그 값이라,
  // 리서처가 화면에서 본 하한과 서버가 적용하는 하한이 어긋나지 않는다.
  // 비어 있으면 자산군 σ̄로 물러서고, 게시 시점에 실측 σ로 다시 검증된다.
  const issues = [
    ...instrument.issues,
    ...validateReportText(input),
    ...validateCardDraft({ ...input.card, sigmaDaily: instrument.sigmaDaily }, now),
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
      // 크기 상한 규칙이 종목 변동성을 함께 본다 — 거친 종목의 큰 예측은 낚시가 아니다.
      // 작성 화면 사전 검사가 쓰는 것과 같은 캐시값이라 두 화면의 판정이 어긋나지 않는다
      sigmaDaily: instrument.sigmaDaily,
      // **판정 불가가 반복되면 사람이 한 번 본다** (2026-08-16). 보상 원장이 생기면서
      // "판정 불가가 실패보다 낫다"가 됐고, 그러면 판정되기 어려운 종목을 고를 유인이
      // 생긴다. 작성 화면 사전 검사에는 넘기지 않는다 — 리서처 이력은 서버가 게시
      // 시점에만 붙이는 사실이고, 미리 보여주면 문턱을 피해 가는 법을 알려주는 셈이다
      unjudgeableCardCount: await countUnjudgeableCards(prisma, report.researcher.userId, now),
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

  // 소급 확정 모드(DAY_CLOSE_AT_JUDGMENT — 장중·장후·주말 게시 단기 카드)는 시세 조회
  // 없이 컷오프 규칙만 검증된다. 그 외에는 외부 시세 조회(트랜잭션 밖)로 기준가를
  // 게시 시점에 확정한다.
  const plan = planBaseMode(cardDraft.assetClass, cardDraft.deadline, now);
  const basePrice =
    plan.baseMode === 'DAY_CLOSE_AT_JUDGMENT'
      ? null
      : await fetchBasePrice(registry, cardDraft, now, plan.baseMode);

  // 종목 실현 변동성을 게시 시점에 재서 카드에 고정한다 — **두 곳이 이 값을 읽는다**:
  // 안정성 별점(stability.ts)과 무정보 도달 확률 p₀(scoring.ts).
  // 캐시(하루)를 쓰는 이유: 리서처가 작성 화면에서 본 σ와 게시된 카드의 σ가 같아야
  // 그때 본 배당표가 그대로 유효하다.
  //
  // **못 쟀을 때의 처분이 이유에 따라 갈린다** (42차 확정):
  //  · 표본 부족 → **게시를 막는다.** 우리가 파는 것은 리포트가 아니라 "이 예측이
  //    무정보 대비 얼마나 위인가"인데, p₀를 짐작으로 계산한 카드는 **뒷받침할 수 없는
  //    점수를 파는 것**이다. 측정할 수 없는 것은 팔지 않는다
  //  · 일시 장애 → 종전대로 게시를 진행한다(별점 "—", p₀는 거친 쪽 폴백).
  //    여기서 막으면 시세 소스 장애 한 번이 전 종목의 게시를 멈춘다
  const sigmaResult = await getInstrumentSigmaResult(
    prisma,
    registry,
    cardDraft.assetClass,
    cardDraft.ticker,
    now,
  );
  if (sigmaResult.sigma === null && sigmaResult.reason === 'INSUFFICIENT_SAMPLES') {
    throw new PublishValidationError([INSUFFICIENT_MARKET_DATA]);
  }
  const sigmaDaily = sigmaResult.sigma;

  // 액면분할 감지 앵커 — 기준가와 같은 순간에 적어 둔다. 이 종가가 나중에 달라지면
  // 그 배수가 곧 조정 배수다 (domain/corporateAction.ts). 실패해도 게시는 진행한다
  const anchor = await captureBaseAnchor(registry, cardDraft.assetClass, cardDraft.ticker, now);

  // 규율 래더(§2.2) 입력: 해당 자산군의 현재 시즌 누적 정보량
  const seasonTotals = await researcherSeasonTotals(prisma, report.researcherId, now);

  // 동시 활성 카드 상한 입력: 같은 자산군에서 게시됐고 아직 판정·철회되지 않은 카드 수
  const activeWhere = {
    assetClass: cardDraft.assetClass,
    withdrawnAt: null,
    judgment: null,
    report: { researcherId: report.researcherId, status: 'PUBLISHED' as const },
  };
  const activeCardCount = await prisma.predictionCard.count({ where: activeWhere });
  // 자산군을 합친 총량 — 나눠 내는 것으로 물량이 배가 되지 않게 한다
  const activeCardCountTotal = await prisma.predictionCard.count({
    where: { ...activeWhere, assetClass: undefined },
  });
  // 그중 장기 카드 — 미판정이라 증거에 안 들어가므로 따로 상한을 건다
  const activeLongCardCount = await prisma.predictionCard.count({
    where: {
      ...activeWhere,
      deadline: { gt: new Date(now.getTime() + LONG_HORIZON_DAYS * 86_400_000) },
    },
  });
  // 판정을 한 번도 안 받아 본 사람은 장기 카드를 못 건다 (JUDGED_BEFORE_LONG_CARDS).
  // **자산군을 가리지 않는다** — 사이클을 한 번 겪었는지를 묻는 것이지 그 자산군의
  // 실력을 묻는 것이 아니다
  const judgedCardCount = await prisma.judgment.count({
    where: { predictionCard: { report: { researcherId: report.researcherId } } },
  });

  const snapshot = preparePublish(
    // 방금 잰 σ로 크기 하한을 다시 검증한다 — 초안은 캐시된 값으로 통과했을 수 있고,
    // 그 사이 종목이 거칠어졌다면 하한도 올라가 있어야 한다
    { ...cardDraft, sigmaDaily },
    {
      priceKrw: report.priceKrw,
      prepaymentRatio: report.prepaymentRatio as PrepaymentRatio,
      tier: report.researcher.tier as Tier,
      promoActive: isPromoActive(report.researcher.promoFeeUntil, now),
      assetClassEvidence: seasonTotals.evidence[cardDraft.assetClass],
      activeCardCount,
      activeCardCountTotal,
      activeLongCardCount,
      judgedCardCount,
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
      data: {
        basePrice: snapshot.basePrice,
        baseMode: snapshot.baseMode,
        sigmaDaily,
        baseCloseAnchor: anchor?.close ?? null,
        baseCloseAnchorDate: anchor?.date ?? null,
        // 도달 판정(reachedJudgmentBatch)은 카드별 플래그 없이 전 카드에 적용된다 —
        // 판정 규칙이 하나뿐이라(기한 내 종가 도달 = 적중) 켜고 끌 대상이 없다
      },
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
   * 지적 자체는 타당했는가 — **세 갈래다** (11차 K-1).
   *
   *   `true`   지적은 타당했다 (경미해서 통과) → 정확도 지표에서 MINOR
   *   `false`  **운영자가 오탐이라고 명시적으로 신고했다**
   *   `null`   아무 표시 없이 승인 (기본)
   *
   * 정확도 지표에서는 `null`도 오탐으로 센다 — 승인의 대다수가 과잉 지적이므로
   * 예외만 표시하게 두는 편이 운영자의 손이 덜 가고 라벨이 비지 않는다.
   * **그런데 자동 격하는 그렇게 세면 안 된다**: 10차 실측에서 무심코 누른 승인
   * 25건 중 6건이면 학생 모델이 영구히 꺼졌다. 그쪽은 `false`(명시적 신고)만
   * 표본으로 센다 (domain/studentRollback.classifyForRollback).
   *
   * **기본값을 `null`로 둔다** — 지표의 뜻은 그대로이고(둘 다 오탐으로 센다),
   * 격하 쪽에서만 "말하지 않았다"와 "틀렸다고 말했다"가 갈린다.
   */
  findingsValid: boolean | null = null,
  /**
   * '지적은 타당했지만 게시 승인한' 사유 (2026-08-27 창업자 지시).
   * findingsValid === true 일 때만 화면이 받아 온다 — 교사 질문지가 "왜 타당한데
   * 통과시켰나(심각도 조정 논의)"를 이 문장으로 싣는다. operatorReason 에 저장된다
   */
  approveReason?: string | null,
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
      // 사유는 '지적 타당(true)'일 때만 뜻이 있다 — null/false 승인에는 기록하지 않는다
      reason: findingsValid === true ? (approveReason?.trim() || undefined) : undefined,
    })),
    prisma.notification.create({
      data: {
        userId: report.researcher.userId,
        type: 'COMPLIANCE_PENDING',
        // **제목·본문 고정** (2026-08-20 사용자 확정 — domain/notice). 승인은 결과가
        // 하나뿐이라 매번 새로 지을 사연이 없고, 제목이 그대로 푸시 문구가 되므로
        // 알림함에서 **열기 전에** "팔 수 있게 됐다"가 읽혀야 한다.
        // 리포트 이름을 달지 않는 이유: 본인이 지은 이름이라 알려 줄 새 사실이 아니다
        title: REVIEW_APPROVED_TITLE,
        body: REVIEW_APPROVED_BODY,
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
    // **반려는 처리되는 순간 바로 알린다** (2026-08-20 사용자 확정).
    //
    // 잠깐 이 통지를 끄고 운영자가 쓴 쪽지만 내보내려 했는데, 되돌렸다. 강제 철회와
    // 성격이 다르기 때문이다: 거기서는 리포트가 닫히고 환불이 나가 **어차피 다른
    // 경로로도 사실이 전달**되지만, 반려는 리포트가 조용히 초안으로 돌아갈 뿐이라
    // 이 한 줄이 없으면 **판매를 기다리던 사람이 아무것도 모른 채 기다린다.**
    // 운영자가 쪽지를 깜빡하는 순간이 곧 그 사고이고, 그 위험을 사람의 기억에 맡길
    // 이유가 없다. 검수 카드의 쪽지 상자는 이 통지 **위에 덧붙이는 말**로 남는다.
    prisma.notification.create({
      data: {
        userId: report.researcher.userId,
        type: 'COMPLIANCE_PENDING',
        title: REVIEW_REJECTED_TITLE,
        body: `운영자 검토 결과 게시가 반려되었습니다. 사유: ${trimmed} · 초안으로 되돌렸으니 문구를 수정해 다시 게시할 수 있습니다.`,
        link: `/researcher/${report.researcherId}`,
        createdAt: now,
      },
    }),
  ]);

  return { reportId, reason: trimmed };
}

/**
 * 철회: 카드 기록은 그대로 남기고(withdrawnAt), 판매를 중지하고 **그 자리에서 정산한다.**
 *
 * 기록은 지우지 않는다 — 게시 후 삭제 불가가 이 도메인의 기본 규칙이고, 판정 배치도
 * `status: CLOSED`인 리포트를 계속 본다(judgmentBatch).
 *
 * **정산을 시한까지 미루지 않는 이유 (2026-08-13 수정).** 예전에는 withdrawnAt만 찍고
 * 판정 배치가 시한에 UNDECIDABLE(WITHDRAWN)로 처리하게 뒀다. 그런데 철회는 **이미
 * 결과가 확정된 사건**이다 — 시한까지 기다려도 전액 환불이라는 답은 바뀌지 않는다.
 * 그동안 구매자 돈만 에스크로에 묶인다. 365일 카드를 이틀 만에 철회하면 **363일**이다.
 * 운영자 강제 철회(complianceService.takedown)는 처음부터 즉시 정산했는데, 리서처 본인
 * 철회만 그러지 않아 같은 사건이 경로에 따라 다르게 끝나고 있었다.
 */
export async function withdrawPredictionCard(
  prisma: PrismaClient,
  reportId: string,
  researcherId: string,
  now = new Date(),
) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: {
      predictionCard: { include: { judgment: true } },
      purchases: { where: { escrowStatus: 'HELD' } },
      researcher: { select: { userId: true } },
    },
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
    // 동시 요청 대비: PUBLISHED 조건을 다시 걸어 원자적으로 전이
    prisma.report.update({
      where: { id: reportId, status: 'PUBLISHED' },
      data: { status: 'CLOSED' },
    }),
    // 판정 불가(WITHDRAWN) 즉시 확정 → 전액 환불 지시서 + 당사자 알림까지 자동 경로와 동일
    ...buildJudgmentWrites(
      prisma,
      { ...card, report: { ...report, purchases: report.purchases } },
      {
        result: { outcome: 'UNDECIDABLE', undecidableReason: 'WITHDRAWN' },
        realizedReturnPct: null,
        score: 0, // 판정 불가는 표본 제외 (§2.2)
        info: 0, // 증거도 없다 — 규율 래더에 들어가면 안 된다
        dataSource: `withdraw:${researcherId}`,
        audit: { withdrawnBy: 'RESEARCHER', researcherId, withdrawnAt: now.toISOString() },
      },
      now,
    ),
  ]);
}

function isPromoActive(promoFeeUntil: Date | null, now = new Date()): boolean {
  return promoFeeUntil !== null && promoFeeUntil > now;
}

async function fetchBasePrice(
  registry: ProviderRegistry,
  card: CardDraft,
  now: Date,
  baseMode: BaseMode = 'FIXED_AT_PUBLISH',
): Promise<number> {
  const provider = resolveProvider(registry, card.assetClass);

  // ── 장이 닫혀 있을 때 현재가가 무엇인가 (2026-08-16 실측) ──────────────
  // KST 03:23(주말)에 KIS 현재가를 물었더니 **마지막 종가를 그대로 줬다**
  // (삼성전자 274,500 = 금요일 종가, SK하이닉스도 일치). 그래서 주말·장 마감 후에
  // 게시되는 장기 카드의 기준가도 정상이다 — 이 경로는 지금까지 **확인 없이 의존**하던
  // 자리였고, 이제 재 봤다.
  //
  // **그럼에도 개장 전 게시 카드는 현재가를 묻지 않는다.** 같은 값이 나오는 것은
  // KIS의 현재 동작이지 우리가 정한 규칙이 아니고, 그 카드에서 우리가 원하는 값은
  // 하나로 정해져 있다 — **직전 거래일 종가**. 정해진 값이 있으면 묻지 않는다
  if (baseMode !== 'PREV_CLOSE_AT_PUBLISH' && provider.getCurrentPrice) {
    // 실시간 현재가를 주는 소스는 게시 순간의 가격을 기준가로 쓴다.
    // 이것이 단기(1일) 예측을 허용해도 "이미 실현된 등락 가로채기"가 불가능한 이유다.
    return provider.getCurrentPrice(card.ticker);
  }

  // 일봉의 마지막 종가 = 직전 거래일 종가 (장중이면 당일 종가가 아직 없다)
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
