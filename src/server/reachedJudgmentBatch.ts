import type { Prisma, PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, TargetType } from '@/domain/constants';
import { JudgmentDeferredError, runJudgmentFromRegistry } from '@/domain/judgmentPipeline';
import type { ProviderRegistry } from '@/domain/marketData';
import { scoreJudgedCard } from '@/domain/scoring';
import { memoizeRegistry } from '@/infra/marketData/memoRegistry';
import { toJudgeableCard } from './cardMapper';
import { rebaseIfAdjusted } from './corporateActionService';
import { isJudgmentPaused } from './judgmentPause';
import { buildJudgmentWrites } from './judgmentWriter';

// 도달 판정 배치 — 일봉 종가가 목표에 닿은 카드를 그 자리에서 판정·정산한다.
// npm run batch:reached (판정 배치와 같은 주기, 하루 1회 이상)
//
// **"조기 판정"이 아니다 (2026-08-10 개념 정리).** 예측 카드가 주장하는 것은
// "검증 기한 **안에** 목표가에 닿는다"이고, 기한은 정산일이 아니라 마감선이다.
// 3일째 종가가 목표를 넘었으면 예측은 그날 이뤄진 것이므로 그날 판정한다 —
// 기한까지 기다리는 쪽이 오히려 판정을 미루는 것이다.
//
// 판정 규칙이 통합되어(judge: 기간 중 종가 극값이 목표 이상 = 적중) **모든 카드**가
// 대상이다. 도달은 단조라 — 한 번 종가로 넘으면 뒤 시세가 무엇을 하든 적중 확정 —
// 오늘 판정하든 기한에 판정하든 결과가 같고, 판정가가 목표가로 고정되므로 점수도 같다.
// 이 배치가 바꾸는 것은 **기록 시점뿐이다.**
//
// 적중만 여기서 확정한다. 실패는 기한 전에 확정될 수 없다 — 남은 기간에 닿을 수 있다.
// "아직 못 닿았다"를 실패로 조기 확정하면 그것은 예측을 자르는 것이다.
//
// 판정이 일어나면 판매도 그 순간 끝난다 — 판정된 카드는 구매 관문·목록에서 이미
// 배제되므로(assertPurchasable·buyableWhere) 별도의 판매 마감 처리가 필요 없다.
// 점수·정산·알림은 buildJudgmentWrites 하나를 공유해 기한 판정과 한 글자도 다르지 않다.

export interface ReachedJudgmentSummary {
  checked: number;
  judged: number;
  /** 아직 목표에 닿은 종가가 없어 그대로 둔 카드 */
  notYet: number;
  deferred: number;
  failed: number;
}

export async function runReachedJudgmentBatch(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
  /** 자산군 스코프 — 시장별로 마감 직후 그 시장만 (없으면 전부) */
  assetClass?: AssetClass,
  /** 배치 락의 자격 검사 — judgmentBatch와 같은 이유 (스플릿 브레인 방어) */
  fence?: () => Prisma.PrismaPromise<unknown>,
): Promise<ReachedJudgmentSummary> {
  // 기한 판정과 같은 이유로 멈춘다 — 되돌리는 중에 도달 판정이 새 판정을 만들면
  // 롤백 계획이 도는 사이에 대상이 늘어난다 (server/judgmentPause)
  if (await isJudgmentPaused(prisma, assetClass)) {
    return { checked: 0, judged: 0, notYet: 0, deferred: 0, failed: 0 };
  }

  const cards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      withdrawnAt: null,
      ...(assetClass ? { assetClass } : {}),
      // 시한 전인 카드만 — 시한이 지났으면 정규 판정 배치의 몫이다
      deadline: { gt: now },
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

  // 종목 단위 조회 — 같은 종목 카드가 몇 장이든 시세 호출은 한 번 (memoRegistry)
  const quotes = memoizeRegistry(registry);

  const summary: ReachedJudgmentSummary = {
    checked: cards.length,
    judged: 0,
    notYet: 0,
    deferred: 0,
    failed: 0,
  };

  for (const card of cards) {
    // **채점보다 먼저** 권리 사건을 반영한다 — 기준가가 옛 눈금에 남아 있으면
    // 2:1 분할이 −50% 폭락으로 읽혀 실패 판정과 역방향 마감이 함께 잘못 일어난다
    try {
      const rebased = await rebaseIfAdjusted(prisma, quotes, card, now);
      if (rebased?.applied) {
        card.basePrice = rebased.basePrice;
        card.targetValue = rebased.targetValue;
        console.log(`권리 사건 반영 ${card.ticker} (${card.id}): ${rebased.note}`);
      } else if (rebased) {
        console.error(`권리 사건 감지·미반영 ${card.ticker} (${card.id}): ${rebased.note}`);
      }
    } catch (e) {
      console.error(`권리 사건 점검 실패 ${card.ticker} (${card.id}):`, e);
    }

    const judgeable = toJudgeableCard(card, card.report.publishedAt!);

    try {
      // 시한을 오늘로 바꿔 같은 파이프라인을 돌린다 (runJudgment는 시한 전이면
      // 이월시키므로 그대로는 못 부른다). 종가 극값은 구간이 길어질수록 커지기만
      // 하므로, 오늘까지의 구간에서 적중이면 원래 시한에도 적중이다.
      const { result, audit, resolvedBasePrice } = await runJudgmentFromRegistry(
        { ...judgeable, deadline: now },
        quotes,
        now,
      );

      // 실패·판정 불가는 아직 확정이 아니다 — 남은 기간이 있다
      if (result.outcome !== 'HIT') {
        summary.notYet++;
        continue;
      }

      const basePrice = resolvedBasePrice ?? card.basePrice;
      const { realizedReturnPct, score, info } = scoreJudgedCard({
        direction: card.direction as Direction,
        targetType: card.targetType as TargetType,
        targetValue: card.targetValue,
        confidence: card.confidence,
        assetClass: card.assetClass as AssetClass,
        sigmaDaily: card.sigmaDaily,
        basePrice,
        settledPrice: result.settledPrice,
        // **원래 시한** 기준 기간 — p₀는 게시된 사양의 함수라 도달 시점과 무관해야
        // 도달 판정과 기한 판정의 점수가 같다 (오늘로 자르면 일찍 닿을수록 점수가 달라진다)
        horizonDays:
          (card.deadline.getTime() - card.report.publishedAt!.getTime()) / 86_400_000,
        outcome: result.outcome,
      });

      const writes = buildJudgmentWrites(
        prisma,
        card,
        { result, realizedReturnPct, score, info, dataSource: audit.dataSource, audit, resolvedBasePrice },
        now,
      );
      await prisma.$transaction(fence ? [fence(), ...writes] : writes);
      summary.judged++;
    } catch (e) {
      if (e instanceof JudgmentDeferredError) {
        // 시세 미도달 — 도달 판정은 서두를 이유가 없다. 다음 회차나 기한 배치가 처리한다
        summary.deferred++;
      } else {
        summary.failed++;
        console.error(`도달 판정 실패 ${card.ticker} (${card.id}):`, e);
      }
    }
  }

  return summary;
}
