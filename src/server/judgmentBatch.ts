import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, TargetType } from '@/domain/constants';
import { JudgmentDeferredError, runJudgmentFromRegistry } from '@/domain/judgmentPipeline';
import type { ProviderRegistry } from '@/domain/marketData';
import { scoreJudgedCard } from '@/domain/scoring';
import { toJudgeableCard } from './cardMapper';
import { buildJudgmentWrites } from './judgmentWriter';
import { memoizeRegistry } from '@/infra/marketData/memoRegistry';

// 판정 배치: 시한이 지난 미판정 카드를 찾아 판정 → 점수 산정 → 에스크로 정산까지
// 하나의 트랜잭션으로 실행한다 (docs/market-data.md §4).
// - 멱등성: Judgment.predictionCardId unique — 재실행해도 중복 판정 불가
// - 데이터 미도달: 이월 (deferred) — 다음 배치가 다시 시도
// - 이월이 STALE_DEFER_DAYS를 넘는 카드는 운영자 보류 큐 대상 (manualJudgmentService)

export interface BatchSummary {
  judged: number;
  deferred: number;
  failed: number;
  /** 시한이 STALE_DEFER_DAYS 이상 지났는데 아직 판정 못 한 카드 — 수동 확인 필요 */
  staleDeferred: string[];
}

/** 이월이 이 일수를 넘으면 운영자 보류 큐 대상 */
export const STALE_DEFER_DAYS = 7;

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
    include: {
      report: {
        include: {
          purchases: { where: { escrowStatus: 'HELD' } },
          researcher: { select: { userId: true } },
        },
      },
    },
    orderBy: { deadline: 'asc' },
  });

  // 같은 종목의 만기 카드가 여러 장이면 조회는 한 번이면 된다 (memoRegistry)
  const quotes = memoizeRegistry(registry);

  const summary: BatchSummary = { judged: 0, deferred: 0, failed: 0, staleDeferred: [] };

  for (const card of dueCards) {
    const judgeable = toJudgeableCard(card, card.report.publishedAt!);

    try {
      const { result, audit, resolvedBasePrice } = await runJudgmentFromRegistry(
        judgeable,
        quotes,
        now,
      );
      const basePrice = resolvedBasePrice ?? card.basePrice;

      const { realizedReturnPct, score } = scoreJudgedCard({
        direction: card.direction as Direction,
        targetType: card.targetType as TargetType,
        targetValue: card.targetValue,
        confidence: card.confidence,
        stability: card.selfStability,
        assetClass: card.assetClass as AssetClass,
        basePrice,
        settledPrice: result.settledPrice,
        outcome: result.outcome,
      });

      const writes = buildJudgmentWrites(
        prisma,
        card,
        { result, realizedReturnPct, score, dataSource: audit.dataSource, audit, resolvedBasePrice },
        now,
      );
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
