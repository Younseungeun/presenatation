import type { PrismaClient } from '@prisma/client';
import type { AssetClass, BaseMode, Direction, TargetType } from '@/domain/constants';
import {
  JudgmentDeferredError,
  runJudgmentFromRegistry,
  type JudgeableCard,
} from '@/domain/judgmentPipeline';
import type { ProviderRegistry } from '@/domain/marketData';
import { computeCardScore, targetPriceToMagnitudePct } from '@/domain/scoring';
import { settle } from '@/domain/settlement';

// 판정 배치: 시한이 지난 미판정 카드를 찾아 판정 → 점수 산정 → 에스크로 정산까지
// 하나의 트랜잭션으로 실행한다 (docs/market-data.md §4).
// - 멱등성: Judgment.predictionCardId unique — 재실행해도 중복 판정 불가
// - 데이터 미도달: 이월 (deferred) — 다음 배치가 다시 시도
// - 이월이 5영업일을 넘는 카드는 운영자 보류 큐 대상 (요약의 staleDeferred로 보고)

export interface BatchSummary {
  judged: number;
  deferred: number;
  failed: number;
  /** 시한이 7일 이상 지났는데 아직 판정 못 한 카드 — 수동 확인 필요 */
  staleDeferred: string[];
}

const STALE_DEFER_DAYS = 7;

export async function judgeAndSettleDueCards(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
): Promise<BatchSummary> {
  const dueCards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      deadline: { lte: now },
      report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
    },
    include: { report: true },
    orderBy: { deadline: 'asc' },
  });

  const summary: BatchSummary = { judged: 0, deferred: 0, failed: 0, staleDeferred: [] };

  for (const card of dueCards) {
    const judgeable: JudgeableCard = {
      assetClass: card.assetClass as AssetClass,
      baseMode: card.baseMode as BaseMode,
      ticker: card.ticker,
      direction: card.direction as Direction,
      targetType: card.targetType as TargetType,
      targetValue: card.targetValue,
      basePrice: card.basePrice,
      withdrawn: card.withdrawnAt !== null,
      publishedAt: card.report.publishedAt!,
      deadline: card.deadline,
    };

    try {
      const { result, audit, resolvedBasePrice } = await runJudgmentFromRegistry(
        judgeable,
        registry,
        now,
      );
      const basePrice = resolvedBasePrice ?? card.basePrice;

      // 점수 산정 (§2.2): 판정 불가는 0점(표본 제외), 그 외는 실현 등락률 기반
      let realizedReturnPct: number | null = null;
      let score = 0;
      if (result.outcome !== 'UNDECIDABLE' && result.settledPrice != null && basePrice) {
        realizedReturnPct = ((result.settledPrice - basePrice) / basePrice) * 100;
        const predictedMagnitudePct =
          card.targetType === 'RETURN_PCT'
            ? card.targetValue
            : targetPriceToMagnitudePct(card.targetValue, basePrice);
        score = computeCardScore(
          {
            direction: card.direction as Direction,
            predictedMagnitudePct,
            confidence: card.confidence,
          },
          realizedReturnPct,
        ).score;
      }

      const heldPurchases = await prisma.purchase.findMany({
        where: { reportId: card.reportId, escrowStatus: 'HELD' },
      });

      await prisma.$transaction([
        prisma.judgment.create({
          data: {
            predictionCardId: card.id,
            outcome: result.outcome,
            undecidableReason: result.undecidableReason ?? null,
            settledPrice: result.settledPrice ?? null,
            realizedReturnPct,
            score,
            dataSource: audit.dataSource,
            marketSnapshotJson: JSON.stringify(audit),
            judgedAt: now,
          },
        }),
        // 소급 확정된 기준가를 카드에 기록 (감사 추적)
        ...(resolvedBasePrice != null
          ? [
              prisma.predictionCard.update({
                where: { id: card.id },
                data: { basePrice: resolvedBasePrice },
              }),
            ]
          : []),
        // 에스크로 3분기 정산 — 금액 보존 불변식은 settle()이 보장
        ...heldPurchases.flatMap((p) => {
          const s = settle({
            amountKrw: p.amountKrw,
            feeRateBp: card.report.feeRateBp!,
            prepaymentRatio: card.report.prepaymentRatio,
            outcome: result.outcome,
          });
          return [
            prisma.settlement.create({
              data: {
                purchaseId: p.id,
                outcome: s.outcome,
                researcherPayoutKrw: s.researcherPayoutKrw,
                platformFeeKrw: s.platformFeeKrw,
                buyerRefundKrw: s.buyerRefundKrw,
                refundType: s.refundType,
                settledAt: now,
              },
            }),
            prisma.purchase.update({
              where: { id: p.id },
              data: { escrowStatus: s.refundType === 'FULL_REFUND' ? 'REFUNDED' : 'SETTLED' },
            }),
            // 실패 환급은 앱 내 크레딧 (유효기간 1년), 판정 불가는 전액 환불(PG 취소)
            ...(s.refundType === 'CREDIT' && s.buyerRefundKrw > 0
              ? [
                  prisma.credit.create({
                    data: {
                      userId: p.buyerId,
                      amountKrw: s.buyerRefundKrw,
                      reason: 'MISS_REFUND',
                      expiresAt: new Date(now.getTime() + 365 * 86_400_000),
                    },
                  }),
                ]
              : []),
          ];
        }),
      ]);
      summary.judged++;
    } catch (e) {
      if (e instanceof JudgmentDeferredError) {
        summary.deferred++;
        const staleDays = (now.getTime() - card.deadline.getTime()) / 86_400_000;
        if (staleDays >= STALE_DEFER_DAYS) {
          summary.staleDeferred.push(`${card.ticker} (${card.id}): ${e.message}`);
        }
      } else {
        summary.failed++;
        console.error(`판정 실패 ${card.ticker} (${card.id}):`, e);
      }
    }
  }

  return summary;
}
