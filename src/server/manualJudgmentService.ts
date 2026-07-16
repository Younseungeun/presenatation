import type { PrismaClient } from '@prisma/client';
import type { Direction, TargetType, UndecidableReason } from '@/domain/constants';
import { UNDECIDABLE_REASONS } from '@/domain/constants';
import { judge, type JudgmentResult, type MarketSnapshot } from '@/domain/judgment';
import { scoreJudgedCard } from '@/domain/scoring';
import { STALE_DEFER_DAYS } from './judgmentBatch';
import { buildJudgmentWrites } from './judgmentWriter';

// 운영자 판정 보류 큐 (§2.5 연장): 자동 판정이 STALE_DEFER_DAYS 이상 이월된 카드를
// 운영자가 검증된 시세를 직접 입력해 수동 판정한다.
// 원칙:
// - 자동 판정 우선 — 시한 경과 STALE_DEFER_DAYS 미만 카드는 수동 판정 불가 (배치가 먼저 시도)
// - 판정·점수·정산 규칙은 자동 경로와 완전히 동일 (judge()·scoreJudgedCard()·buildJudgmentWrites 공유)
// - 사유(reason) 필수 + 입력값·운영자 식별자를 감사 스냅샷에 기록 (분쟁 재현용)

export class ManualJudgmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualJudgmentError';
  }
}

export interface QueueEntry {
  cardId: string;
  reportId: string;
  reportTitle: string;
  researcherName: string;
  assetClass: string;
  ticker: string;
  assetName: string;
  direction: string;
  targetType: string;
  targetValue: number;
  basePrice: number | null;
  baseMode: string;
  deadline: Date;
  /** 시한 경과 일수 (내림) */
  staleDays: number;
  /** 에스크로 보관 중 구매 건수 — 판정 시 정산 대상 */
  heldPurchases: number;
  withdrawn: boolean;
}

/** 시한이 STALE_DEFER_DAYS 이상 지났는데 아직 판정되지 않은 카드 (오래된 순) */
export async function getManualJudgmentQueue(
  prisma: PrismaClient,
  now = new Date(),
): Promise<QueueEntry[]> {
  const staleBefore = new Date(now.getTime() - STALE_DEFER_DAYS * 86_400_000);
  const cards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      deadline: { lte: staleBefore },
      report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
    },
    include: {
      report: {
        include: {
          researcher: { include: { user: { select: { penName: true, email: true } } } },
          purchases: { where: { escrowStatus: 'HELD' }, select: { id: true } },
        },
      },
    },
    orderBy: { deadline: 'asc' },
  });

  return cards.map((c) => ({
    cardId: c.id,
    reportId: c.reportId,
    reportTitle: c.report.title,
    researcherName: c.report.researcher.user.penName ?? c.report.researcher.user.email,
    assetClass: c.assetClass,
    ticker: c.ticker,
    assetName: c.assetName,
    direction: c.direction,
    targetType: c.targetType,
    targetValue: c.targetValue,
    basePrice: c.basePrice,
    baseMode: c.baseMode,
    deadline: c.deadline,
    staleDays: Math.floor((now.getTime() - c.deadline.getTime()) / 86_400_000),
    heldPurchases: c.report.purchases.length,
    withdrawn: c.withdrawnAt !== null,
  }));
}

/** 수동 판정 입력: 시세 입력(판정 규칙은 자동과 동일) 또는 판정 불가 처리 */
export type ManualDecision =
  | {
      type: 'PRICE';
      /** 시한 종가 — RETURN_PCT 판정에 필수 */
      priceAtDeadline?: number;
      /** 게시~시한 최고가 — TARGET_PRICE 상승 판정에 필수 */
      highSincePublish?: number;
      /** 게시~시한 최저가 — TARGET_PRICE 하락 판정에 필수 */
      lowSincePublish?: number;
      /** 기준가 미확정(소급 카드) 시 운영자가 확정하는 기준가 */
      basePrice?: number;
    }
  | { type: 'UNDECIDABLE'; undecidableReason: UndecidableReason };

export interface ManualJudgeInput {
  cardId: string;
  operatorUserId: string;
  /** 수동 판정 사유 — 필수, 감사 스냅샷에 기록 */
  reason: string;
  decision: ManualDecision;
}

/**
 * 보류 카드 1건을 수동 판정하고 자동 경로와 동일하게 점수·정산까지 실행한다.
 * 반환: 기록된 판정 결과.
 */
export async function manualJudgeCard(
  prisma: PrismaClient,
  input: ManualJudgeInput,
  now = new Date(),
): Promise<JudgmentResult & { score: number }> {
  if (!input.reason.trim()) {
    throw new ManualJudgmentError('수동 판정 사유는 필수입니다');
  }

  const card = await prisma.predictionCard.findUnique({
    where: { id: input.cardId },
    include: {
      judgment: { select: { id: true } },
      report: { include: { purchases: { where: { escrowStatus: 'HELD' } } } },
    },
  });
  if (!card) throw new ManualJudgmentError('카드를 찾을 수 없습니다');
  if (card.judgment) throw new ManualJudgmentError('이미 판정된 카드입니다');
  if (!card.report.publishedAt || !['PUBLISHED', 'CLOSED'].includes(card.report.status)) {
    throw new ManualJudgmentError('게시된 리포트의 카드만 판정할 수 있습니다');
  }
  const staleDays = (now.getTime() - card.deadline.getTime()) / 86_400_000;
  if (staleDays < STALE_DEFER_DAYS) {
    throw new ManualJudgmentError(
      `자동 판정 우선 — 시한 경과 ${STALE_DEFER_DAYS}일 미만 카드는 수동 판정할 수 없습니다`,
    );
  }

  let result: JudgmentResult;
  let resolvedBasePrice: number | null = null;

  if (input.decision.type === 'UNDECIDABLE') {
    if (!UNDECIDABLE_REASONS.includes(input.decision.undecidableReason)) {
      throw new ManualJudgmentError(`판정 불가 사유가 유효하지 않습니다: ${input.decision.undecidableReason}`);
    }
    result = { outcome: 'UNDECIDABLE', undecidableReason: input.decision.undecidableReason };
  } else {
    const basePrice = card.basePrice ?? input.decision.basePrice ?? null;
    if (card.basePrice == null && input.decision.basePrice != null) {
      if (input.decision.basePrice <= 0) {
        throw new ManualJudgmentError('기준가는 양수여야 합니다');
      }
      resolvedBasePrice = input.decision.basePrice; // 소급 카드: 운영자 확정 기준가를 카드에 기록
    }

    const snapshot: MarketSnapshot = {
      status: 'TRADED',
      priceAtDeadline: input.decision.priceAtDeadline,
      highSincePublish: input.decision.highSincePublish,
      lowSincePublish: input.decision.lowSincePublish,
    };
    result = judge(
      {
        direction: card.direction as Direction,
        targetType: card.targetType as TargetType,
        targetValue: card.targetValue,
        basePrice: basePrice ?? 0,
        withdrawn: card.withdrawnAt !== null,
      },
      snapshot,
    );
    // 시세 입력 경로에서 UNDECIDABLE이 나오면 입력 누락 — 명시적으로 되돌려 보정 유도.
    // (철회 카드는 예외 — 규칙상 판정 불가가 맞으므로 그대로 기록)
    if (result.outcome === 'UNDECIDABLE' && result.undecidableReason !== 'WITHDRAWN') {
      throw new ManualJudgmentError(
        '입력한 시세로 판정할 수 없습니다 — 필요한 가격(종가/고가/저가/기준가)을 채우거나 판정 불가로 처리하세요',
      );
    }
  }

  const { realizedReturnPct, score } = scoreJudgedCard({
    direction: card.direction as Direction,
    targetType: card.targetType as TargetType,
    targetValue: card.targetValue,
    confidence: card.confidence,
    basePrice: resolvedBasePrice ?? card.basePrice,
    settledPrice: result.settledPrice,
    outcome: result.outcome,
  });

  const writes = buildJudgmentWrites(
    prisma,
    card,
    {
      result,
      realizedReturnPct,
      score,
      dataSource: `manual:${input.operatorUserId}`,
      audit: {
        manual: true,
        operatorUserId: input.operatorUserId,
        reason: input.reason.trim(),
        decision: input.decision,
        judgedAt: now.toISOString(),
      },
      resolvedBasePrice,
    },
    now,
  );
  await prisma.$transaction(writes);

  return { ...result, score };
}
