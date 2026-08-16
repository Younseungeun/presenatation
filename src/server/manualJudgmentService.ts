import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, TargetType, UndecidableReason } from '@/domain/constants';
import { UNDECIDABLE_REASONS } from '@/domain/constants';
import { judge, type JudgmentResult, type MarketSnapshot } from '@/domain/judgment';
import { scoreJudgedCard } from '@/domain/scoring';
import { STALE_DEFER_DAYS } from './judgmentBatch';
import { buildJudgmentWrites } from './judgmentWriter';
import {
  ApprovalError,
  consumeApproval,
  consumeOperatorRecheck,
  isSoloOperatorMode,
  requestApproval,
} from './operatorApprovalService';

// 운영자 판정 보류 큐 (§2.5 연장): 자동 판정이 STALE_DEFER_DAYS 이상 이월된 카드를
// 운영자가 검증된 시세를 직접 입력해 수동 판정한다.
// 원칙:
// - 자동 판정 우선 — 시한 경과 STALE_DEFER_DAYS 미만 카드는 수동 판정 불가 (배치가 먼저 시도)
// - 판정·점수·정산 규칙은 자동 경로와 완전히 동일 (judge()·scoreJudgedCard()·buildJudgmentWrites 공유)
// - 사유(reason) 필수 + 입력값·운영자 식별자를 감사 스냅샷에 기록 (분쟁 재현용)

export class ManualJudgmentError extends Error {
  constructor(
    message: string,
    /** RECHECK_REQUIRED = 1인 운영 모드 — 화면이 지문·얼굴 확인을 띄우고 재시도한다 */
    readonly code?: 'RECHECK_REQUIRED',
  ) {
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

/**
 * 사람이 봐야 하는 카드 (오래된 순) — 시한이 STALE_DEFER_DAYS 이상 지났는데 판정 안 된 것.
 *
 * **기준은 시간 하나뿐이다.** 한때 "자동 재시도를 다 쓴 카드"도 넣었는데, 시도 횟수는
 * 시간이 아니라서(재시작이 잦으면 하루 만에 소진된다) 멀쩡한 카드가 큐로 밀려왔다.
 * 지금은 배치가 횟수로 손을 떼지 않으므로 이 갈래 자체가 필요 없다
 * (judgmentBatch.MAX_DEFER_ATTEMPTS 주석).
 */
export async function getManualJudgmentQueue(
  prisma: PrismaClient,
  now = new Date(),
): Promise<QueueEntry[]> {
  const staleBefore = new Date(now.getTime() - STALE_DEFER_DAYS * 86_400_000);
  const cards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
      // **두 갈래가 여기 모인다.** 시간이 지나 자동 판정이 안 된 카드(원래 기준)와,
      // 되돌리면서 "사람만 판정" 표시가 붙은 카드다. 후자는 7일을 기다릴 이유가 없다 —
      // 자동 배치가 아예 손대지 않으므로 여기 안 오면 **아무 데도 안 간다**
      OR: [{ deadline: { lte: staleBefore } }, { manualJudgmentOnly: true }],
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
      /** 시한 종가 — 실패 시 실현값이자, 극값을 모를 때의 기본값 */
      priceAtDeadline?: number;
      /** 게시~시한 **일봉 종가 최고값** — 상승 카드의 도달 판정. 비우면 시한 종가로 본다 */
      maxCloseSincePublish?: number;
      /** 게시~시한 **일봉 종가 최저값** — 하락 카드의 도달 판정. 비우면 시한 종가로 본다 */
      minCloseSincePublish?: number;
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
      report: {
        include: {
          purchases: { where: { escrowStatus: 'HELD' } },
          researcher: { select: { userId: true } },
        },
      },
    },
  });
  if (!card) throw new ManualJudgmentError('카드를 찾을 수 없습니다');
  if (card.judgment) throw new ManualJudgmentError('이미 판정된 카드입니다');
  if (!card.report.publishedAt || !['PUBLISHED', 'CLOSED'].includes(card.report.status)) {
    throw new ManualJudgmentError('게시된 리포트의 카드만 판정할 수 있습니다');
  }
  // **자동 판정이 우선이다** — 배치가 아직 시도할 여지가 있으면 사람이 끼어들지 않는다.
  //
  // 단 `manualJudgmentOnly`면 이 대기가 뜻을 잃는다 (2026-08-15): 그 카드는 자동 배치의
  // 조회에서 통째로 빠져 있어 **기다려도 아무도 시도하지 않는다.** 시세 소스 간 판정
  // 불일치로 올라온 카드가 특히 그렇다 — 시한 직후에 즉시 큐에 뜨는데 7일 동안 화면에서
  // 보이기만 하고 눌리지 않았다. 우선권을 줄 상대가 없는 자리에서의 대기는 지연일 뿐이다.
  const staleDays = (now.getTime() - card.deadline.getTime()) / 86_400_000;
  if (!card.manualJudgmentOnly && staleDays < STALE_DEFER_DAYS) {
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

    // 판정 규칙이 "기한 내 목표가 도달"로 통합되면서 **구간 극값이 항상 필요해졌다.**
    // 운영자가 종가만 아는 경우(대부분의 데이터 결측 상황)에는 극값을 종가로 본다 —
    // "장중에 더 유리한 순간이 있었는지 모른다"는 상태에서 유리한 쪽을 지어내지 않는
    // 보수적 기본값이다. 실제 고가·저가를 아는 운영자는 직접 입력해 이를 덮는다.
    const snapshot: MarketSnapshot = {
      status: 'TRADED',
      priceAtDeadline: input.decision.priceAtDeadline,
      maxCloseSincePublish: input.decision.maxCloseSincePublish ?? input.decision.priceAtDeadline,
      minCloseSincePublish: input.decision.minCloseSincePublish ?? input.decision.priceAtDeadline,
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

  // ── 기계 판정 이력이 없으면 2인 승인이다 (2026-08-16 검토 4차 Q1) ──
  // 되돌리기를 거쳐 온 카드(JudgmentRevert 묘비 있음)는 그 길목(이의 인정)에 이미
  // 2인이 섰으므로 걸지 않는다 — 같은 체인에 관문을 두 번 세우면 사고 복구의 대량
  // 수동 판정이 두 배로 느려질 뿐이다. 반대로 시세 결측·신규 상장으로 **기계의 1차
  // 판정 없이** 여기 온 카드는 운영자가 넣는 숫자가 곧 원천 데이터라, 이 입력 창구가
  // 조작되면 앞선 모든 방어가 무력해진다. (자리는 입력 검증 뒤 — 형식이 틀린 입력에
  // 승인서를 태우지 않는다)
  const priorJudgment = await prisma.judgmentRevert.findFirst({
    where: { predictionCardId: card.id },
    select: { id: true },
  });
  if (!priorJudgment) {
    try {
      await consumeApproval(prisma, { action: 'FIRST_MANUAL_JUDGMENT', targetId: card.id }, now);
    } catch (e) {
      if (!(e instanceof ApprovalError)) throw e;
      // 승인서가 없다 — 1인 운영이면 생체 재확인, 다인이면 요청을 올리고 대기
      // (2026-08-17 사용자 확정 — unfreezePayouts와 같은 갈림)
      if (await isSoloOperatorMode(prisma)) {
        try {
          await consumeOperatorRecheck(prisma, input.operatorUserId, now);
        } catch (re) {
          if (!(re instanceof ApprovalError)) throw re;
          throw new ManualJudgmentError(re.message, 'RECHECK_REQUIRED');
        }
      } else {
        await requestApproval(
          prisma,
          {
            action: 'FIRST_MANUAL_JUDGMENT',
            targetId: card.id,
            summary: `${card.assetName} (${card.ticker}) 수동 판정 — 기계 판정 이력 없음`,
            requestedBy: input.operatorUserId,
            reason: input.reason.trim(),
          },
          now,
        );
        throw new ManualJudgmentError(
          '기계 판정 이력이 없는 카드의 수동 판정에는 다른 운영자의 승인이 필요합니다 — ' +
            '승인 요청을 올려두었습니다. 승인되면 같은 입력으로 다시 판정하세요.',
        );
      }
    }
  }

  const { realizedReturnPct, score, info } = scoreJudgedCard({
    direction: card.direction as Direction,
    targetType: card.targetType as TargetType,
    targetValue: card.targetValue,
    confidence: card.confidence,
    assetClass: card.assetClass as AssetClass,
    sigmaDaily: card.sigmaDaily,
    basePrice: resolvedBasePrice ?? card.basePrice,
    settledPrice: result.settledPrice,
    horizonDays: card.report.publishedAt
      ? (card.deadline.getTime() - card.report.publishedAt.getTime()) / 86_400_000
      : null,
    outcome: result.outcome,
  });

  const writes = buildJudgmentWrites(
    prisma,
    card,
    {
      result,
      realizedReturnPct,
      score,
      info,
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
