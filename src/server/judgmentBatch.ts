import type { Prisma, PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, TargetType } from '@/domain/constants';
import { JudgmentDeferredError, runJudgmentFromRegistry } from '@/domain/judgmentPipeline';
import type { ProviderRegistry } from '@/domain/marketData';
import { scoreJudgedCard } from '@/domain/scoring';
import { toJudgeableCard } from './cardMapper';
import { rebaseIfAdjusted } from './corporateActionService';
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
  /** 이번 회차에 손대지 못하고 남은 카드 수 — 0이 아니면 곧바로 한 번 더 돌아야 한다 */
  remaining: number;
}

/** 이월이 이 일수를 넘으면 운영자 보류 큐 대상 */
export const STALE_DEFER_DAYS = 7;

/**
 * 한 회차에 처리할 카드 수 상한.
 *
 * 판정은 카드마다 시세를 부르는데 KIS는 **호출 간격 1.1초**다. 분기말처럼 시한이 몰린
 * 날 수백 장이 한 번에 들어오면 회차 하나가 수백 초를 잡아먹고, 그동안 큐 뒤의 다른
 * 배치(판매 마감·감시 갱신)가 통째로 밀린다. 토큰 만료·프로세스 재시작이라도 끼면
 * **그 회차가 통째로 날아간다** — 20장씩 끊으면 최악이 22초고, 죽어도 20장어치만 잃는다.
 *
 * 판정은 멱등이라 여러 회차로 나눠 돌아도 결과가 같다. 남은 수(remaining)를 돌려주면
 * 스케줄러가 그 자리에서 다시 부른다.
 */
export const JUDGE_BATCH_SIZE = 20;

/**
 * 종목 마스터에서 사라졌나 — 상장폐지의 신호.
 * 마스터는 매일 동기화되고(스케줄러 06:00), 폐지된 종목은 그 목록에서 빠지면서
 * active=false가 된다. 마스터에 아예 없는 경우(레코드 없음)도 같은 뜻이다.
 */
async function isDelisted(
  prisma: PrismaClient,
  assetClass: string,
  ticker: string,
): Promise<boolean> {
  const row = await prisma.instrument.findUnique({
    where: { assetClass_ticker: { assetClass, ticker } },
    select: { active: true },
  });
  return row === null || row.active === false;
}

export async function judgeAndSettleDueCards(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
  /** 자산군 스코프 — 시장별로 마감 직후 그 시장만 판정한다 (없으면 전부) */
  assetClass?: AssetClass,
): Promise<BatchSummary> {
  // HELD 구매까지 한 번에 조회 — 카드별 개별 쿼리(N+1) 제거
  const where: Prisma.PredictionCardWhereInput = {
    judgment: null,
    ...(assetClass ? { assetClass } : {}),
    deadline: { lte: now },
    report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
  };

  // **한 번에 다 하지 않는다** (JUDGE_BATCH_SIZE 주석 참고). 오래된 시한부터 —
  // 이월이 길어진 카드가 뒤로 밀리면 돈이 묶인 채 계속 밀린다
  const dueCards = await prisma.predictionCard.findMany({
    where,
    include: {
      report: {
        include: {
          purchases: { where: { escrowStatus: 'HELD' } },
          researcher: { select: { userId: true } },
        },
      },
    },
    orderBy: { deadline: 'asc' },
    take: JUDGE_BATCH_SIZE,
  });
  const totalDue = await prisma.predictionCard.count({ where });

  // 같은 종목의 만기 카드가 여러 장이면 조회는 한 번이면 된다 (memoRegistry)
  const quotes = memoizeRegistry(registry);

  const summary: BatchSummary = {
    judged: 0,
    deferred: 0,
    failed: 0,
    staleDeferred: [],
    remaining: Math.max(0, totalDue - dueCards.length),
  };

  for (const card of dueCards) {
    // 정산이 걸린 자리라 권리 사건 반영이 더 중요하다 — 옛 눈금으로 채점하면
    // 점수·환불이 한꺼번에 틀린다 (도달 판정 배치와 같은 함수를 쓴다)
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
      const { result, audit, resolvedBasePrice } = await runJudgmentFromRegistry(
        judgeable,
        quotes,
        now,
      );
      const basePrice = resolvedBasePrice ?? card.basePrice;

      const { realizedReturnPct, score, info } = scoreJudgedCard({
        direction: card.direction as Direction,
        targetType: card.targetType as TargetType,
        targetValue: card.targetValue,
        confidence: card.confidence,
        assetClass: card.assetClass as AssetClass,
        // 게시 시점에 잰 종목 변동성 — p₀의 입력 (없으면 자산군 σ̄로 폴백)
        sigmaDaily: card.sigmaDaily,
        basePrice,
        settledPrice: result.settledPrice,
        // p₀(무정보 도달 확률)의 입력 — 게시된 사양(게시→시한)의 기간
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
      await prisma.$transaction(writes);
      summary.judged++;
    } catch (e) {
      if (e instanceof JudgmentDeferredError) {
        // **상장폐지 판별** — 시세가 안 오는 것만으로는 폐지인지 일시적 결측인지 모른다.
        // 그런데 종목 마스터에서 사라진 종목은 다음 동기화에서 active=false가 되므로,
        // 두 사실이 겹치면(마스터에서 빠짐 + 시세 없음) 폐지로 본다.
        //
        // 둘 다 요구하는 이유: 우리가 유니버스에서 뺀 종목(ETF 필터 등)도 active=false가
        // 되는데 시세는 멀쩡히 나온다. 그때 폐지로 처리하면 멀쩡한 카드가 환불된다.
        // 반대로 시세만 없는 경우는 휴장·일시 장애일 수 있어 이월이 맞다.
        if (await isDelisted(prisma, card.assetClass, card.ticker)) {
          const result = {
            outcome: 'UNDECIDABLE' as const,
            undecidableReason: 'DELISTED' as const,
          };
          await prisma.$transaction(
            buildJudgmentWrites(
              prisma,
              card,
              {
                result,
                realizedReturnPct: null,
                score: 0, // 판정 불가는 표본에서 빠진다 (§2.2)
                info: 0, // 증거도 없다 — 규율 래더에 들어가면 안 된다
                dataSource: 'instrument-master',
                audit: {
                  delisted: true,
                  reason: '종목 마스터에서 사라졌고 시세도 조회되지 않습니다',
                  deferMessage: e.message,
                  judgedAt: now.toISOString(),
                },
                resolvedBasePrice: null,
              },
              now,
            ),
          );
          summary.judged++;
          console.log(`상장폐지 판정 불가 ${card.ticker} (${card.id}) — 전액 환불`);
          continue;
        }
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
