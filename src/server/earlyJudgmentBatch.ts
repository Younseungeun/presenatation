import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, TargetType } from '@/domain/constants';
import { JudgmentDeferredError, runJudgmentFromRegistry } from '@/domain/judgmentPipeline';
import type { ProviderRegistry } from '@/domain/marketData';
import { scoreJudgedCard } from '@/domain/scoring';
import { toJudgeableCard } from './cardMapper';
import { buildJudgmentWrites } from './judgmentWriter';

// 조기 판정(터치형) — 시한 전에 결과가 이미 확정된 카드를 그 자리에서 판정·정산한다.
// npm run batch:earlyjudge (판정 배치와 같은 주기로 돌린다)
//
// ── 이 배치가 지키는 단 하나의 불변식 ───────────────────────────────
//   **어떤 카드의 결과도 바꾸지 않는다. 바뀌는 것은 기록 시점뿐이다.**
//
// 그래서 두 겹으로 제한한다:
//
// ① **TARGET_PRICE 카드만.** 판정 규칙(domain/judgment.ts)을 보면 목표가형은
//    "게시~시한 사이 고가가 목표 이상"(하락은 저가)이라 **단조**다 — 한 번 닿으면
//    그 뒤 시세가 무엇을 하든 HIT이 확정된다. 시한까지 기다려도 답이 같다.
//    반면 수익률형(RETURN_PCT)은 **시한 종가**만 보므로 오늘 목표를 넘겨도 확정이
//    아니다. 되돌아오면 MISS다. 여기에 조기 판정을 넣으면 그건 기록 시점이 아니라
//    **판정 규칙 자체를 터치형으로 바꾸는 것**이고, 적중 확률이 일괄 상향되어
//    스팸 기대값·등급 임계값을 다시 시뮬레이션해야 한다. 그 전까지는 손대지 않는다.
//
// ② **HIT만.** MISS는 시한 전에 확정되지 않는다 — 남은 기간에 목표에 닿을 수 있다.
//    "아직 못 닿았다"를 실패로 조기 확정하면 그건 예측을 자르는 것이다.
//
// 구현은 판정 배치와 **같은 파이프라인을 그대로 쓴다**: 시한을 오늘로 바꿔 부르고
// (runJudgment는 now < deadline이면 이월시키므로 그대로는 못 부른다), 결과가 HIT일
// 때만 기록한다. 점수·정산·알림은 buildJudgmentWrites 하나를 공유하므로 자동 판정과
// 한 글자도 다르지 않다.
//
// ── 점수에 미치는 영향 (숨기지 않고 적어 둔다) ──────────────────────
// 목표가형 HIT의 판정가는 "구간 내 극값"이라, 일찍 끊으면 극값이 작아진다.
//  · 방향·크기 점수: 실현이 목표를 넘긴 구간에서 D = |목표|로 **포화**한다 → 변화 없음
//  · 안정성 점수: 초과분이 작을수록 오차 ε이 작다 → **조기 판정이 유리하다**
// 즉 조기 판정은 안정성 점수를 낮추지 않고 다소 올린다. 이것을 받아들이는 근거는
// "목표에 닿은 그 순간의 정밀도"가 예측이 실제로 주장한 바에 더 가깝다는 것이다 —
// 목표 달성 후의 추가 상승은 리서처가 예측한 적 없는 몫이라 벌점 근거가 약하다.
// 다만 등급 임계값은 이 상향을 반영해 재점검이 필요하다 (scripts/simTierThresholds.ts).

export interface EarlyJudgmentSummary {
  checked: number;
  judged: number;
  /** 아직 목표에 닿지 않아 그대로 둔 카드 */
  notYet: number;
  deferred: number;
  failed: number;
}

export async function runEarlyJudgmentBatch(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
): Promise<EarlyJudgmentSummary> {
  const cards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      withdrawnAt: null,
      // 시한 전인 카드만 — 시한이 지났으면 정규 판정 배치의 몫이다
      deadline: { gt: now },
      // 게시 시점에 조기 판정이 켜져 있던 카드만 (규칙 소급 적용 금지)
      earlyJudgment: true,
      // 목표가형만 — 위 ① 참고
      targetType: 'TARGET_PRICE',
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

  const summary: EarlyJudgmentSummary = {
    checked: cards.length,
    judged: 0,
    notYet: 0,
    deferred: 0,
    failed: 0,
  };

  for (const card of cards) {
    const judgeable = toJudgeableCard(card, card.report.publishedAt!);

    try {
      // **시한을 오늘로 바꿔 같은 파이프라인을 돌린다.** 목표가형은 구간 극값으로
      // 판정하므로, 구간을 오늘까지로 줄여도 HIT이 나왔다면 원래 시한에도 HIT이다
      // (극값은 구간이 길어질수록 커지기만 한다).
      const { result, audit, resolvedBasePrice } = await runJudgmentFromRegistry(
        { ...judgeable, deadline: now },
        registry,
        now,
      );

      // MISS·판정 불가는 아직 확정이 아니다 — 남은 기간이 있다
      if (result.outcome !== 'HIT') {
        summary.notYet++;
        continue;
      }

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
        // 시세 미도달 — 조기 판정은 서두를 이유가 없다. 다음 회차나 시한 배치가 처리한다
        summary.deferred++;
      } else {
        summary.failed++;
        console.error(`조기 판정 실패 ${card.ticker} (${card.id}):`, e);
      }
    }
  }

  return summary;
}
