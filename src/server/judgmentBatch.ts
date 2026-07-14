import type { Prisma, PrismaClient } from '@prisma/client';
import type { Direction, TargetType } from '@/domain/constants';
import { JudgmentDeferredError, runJudgmentFromRegistry } from '@/domain/judgmentPipeline';
import type { ProviderRegistry } from '@/domain/marketData';
import { scoreJudgedCard } from '@/domain/scoring';
import { settle } from '@/domain/settlement';
import { toJudgeableCard } from './cardMapper';

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
  // HELD 구매까지 한 번에 조회 — 카드별 개별 쿼리(N+1) 제거
  const dueCards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      deadline: { lte: now },
      report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
    },
    include: { report: { include: { purchases: { where: { escrowStatus: 'HELD' } } } } },
    orderBy: { deadline: 'asc' },
  });

  const summary: BatchSummary = { judged: 0, deferred: 0, failed: 0, staleDeferred: [] };

  for (const card of dueCards) {
    const judgeable = toJudgeableCard(card, card.report.publishedAt!);

    try {
      const { result, audit, resolvedBasePrice } = await runJudgmentFromRegistry(
        judgeable,
        registry,
        now,
      );
      const basePrice = resolvedBasePrice ?? card.basePrice;

      const { realizedReturnPct, score } = scoreJudgedCard({
        direction: card.direction as Direction,
        targetType: card.targetType as TargetType,
        targetValue: card.targetValue,
        confidence: card.confidence,
        basePrice,
        settledPrice: result.settledPrice,
        outcome: result.outcome,
      });

      const writes: Prisma.PrismaPromise<unknown>[] = [
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
      ];

      // 소급 확정된 기준가를 카드에 기록 (감사 추적)
      if (resolvedBasePrice != null) {
        writes.push(
          prisma.predictionCard.update({
            where: { id: card.id },
            data: { basePrice: resolvedBasePrice },
          }),
        );
      }

      // 에스크로 3분기 정산 — 금액 보존 불변식은 settle()이 보장.
      // 환불은 항상 현금(확정) — Settlement 기록이 PG 취소/계좌이체 지시서 역할.
      // 전액 환불 건만 REFUNDED로 구분.
      for (const p of card.report.purchases) {
        const s = settle({
          amountKrw: p.amountKrw,
          feeRateBp: card.report.feeRateBp!,
          prepaymentRatio: card.report.prepaymentRatio,
          outcome: result.outcome,
        });
        writes.push(
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
            data: { escrowStatus: s.buyerRefundKrw === p.amountKrw ? 'REFUNDED' : 'SETTLED' },
          }),
        );
      }

      await prisma.$transaction(writes);
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
