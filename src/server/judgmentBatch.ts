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
  /**
   * 이번 회차에서 마지막으로 손댄 카드의 위치 — **다음 회차의 커서다.**
   *
   * 왜 개수가 아니라 커서인가: 이월된 카드는 Judgment 행이 안 생겨 다음 조회에도
   * 그대로 잡힌다. 커서 없이 `take 20`만 쓰면 **오래된 이월 20장이 매 회차 앞자리를
   * 차지해 그 뒤 카드는 영원히 판정되지 않는다.**
   *
   * 그리고 Prisma의 `cursor`(행 id 기반)를 쓸 수 없다 — 이 회차가 **자기가 방금 만든
   * 조건**(nextAttemptAt 백오프)으로 커서 행을 필터에서 밀어내기 때문이다. 커서 행이
   * where를 만족하지 않으면 페이지가 어긋난다(실제로 5장이 4장으로 나왔다).
   * 그래서 정렬 키(deadline, id) 자체를 조건으로 쓰는 **키셋 페이지네이션**을 쓴다.
   */
  cursor: { deadline: Date; id: string } | null;
  /** 커서 뒤에 더 있을 수 있다 — 스케줄러가 이어서 한 번 더 돈다 */
  hasMore: boolean;
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
 * 이월 재시도 간격 — **실패할수록 뒤로 미룬다** (지수 백오프).
 *
 * 이월된 카드는 Judgment 행을 만들지 않아 다음 조회에도 그대로 잡힌다. 시세 소스가
 * 특정 종목에서 계속 실패하면(티커 변경·상폐 직전·데이터 공백) 그 카드가 매 회차
 * KIS 호출을 갉아먹는다 — 100건이면 회차마다 110초를 **아무 성과 없이** 쓴다.
 *
 * 눈금이 시간이 아니라 **날 단위까지 가는** 이유: 판정 배치는 시장 마감 직후 하루
 * 한 번 돈다. 백오프가 24시간 안에서만 놀면 다음 날 어차피 전부 다시 돌아와, 줄이려던
 * 비용이 그대로다. 앞쪽을 짧게 둔 것은 **일시 장애의 자동 복구**를 살리기 위해서다 —
 * KIS 새벽 점검처럼 몇 시간이면 낫는 것은 2~3회차 안에 스스로 판정된다.
 */
export const DEFER_BACKOFF_MS = [
  // **첫 실패는 미루지 않는다.** 한 번의 결측은 대개 일시적이고(그날 봉이 아직 안 올라옴),
  // 같은 회차 안에서 같은 카드를 다시 만나는 것은 **커서**가 이미 막고 있다.
  // 백오프가 벌해야 하는 것은 첫 실패가 아니라 **반복되는 실패**다.
  0, // 1회 → 다음 회차에 바로 다시
  60 * 60_000, // 2회 → 1시간
  6 * 3_600_000, // 3회 → 6시간
  24 * 3_600_000, // 4회 → 하루
  3 * 86_400_000, // 5회 → 사흘
] as const;

/**
 * 이만큼 이월되면 자동 재시도를 멈추고 **사람에게 넘긴다.**
 *
 * 무한히 미루지 않는 이유: 백오프만 두면 카드가 조용히 뒤로 밀리기만 하고 아무도
 * 모른 채 돈이 묶인다. 여기 닿으면 운영자 판정 큐로 올라간다(manualJudgmentService).
 */
export const MAX_DEFER_ATTEMPTS = DEFER_BACKOFF_MS.length;

/**
 * 다음 시도 시각. **정차(parking)는 이 값이 아니라 deferCount가 표현한다** —
 * null을 "그만"의 뜻으로 쓰면 "아직 한 번도 이월 안 됨"과 구별되지 않는다.
 */
export function nextAttemptAfterDefer(deferCount: number, now: Date): Date {
  // deferCount는 **이번 실패까지 센 값**이다 — 1회차가 눈금 0번을 쓴다
  const idx = Math.min(Math.max(deferCount - 1, 0), DEFER_BACKOFF_MS.length - 1);
  return new Date(now.getTime() + DEFER_BACKOFF_MS[idx]);
}

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
  /** 이어서 돌 때의 커서 — 직전 회차의 cursor */
  after?: { deadline: Date; id: string },
): Promise<BatchSummary> {
  // HELD 구매까지 한 번에 조회 — 카드별 개별 쿼리(N+1) 제거
  const where: Prisma.PredictionCardWhereInput = {
    judgment: null,
    ...(assetClass ? { assetClass } : {}),
    deadline: { lte: now },
    report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
    // 백오프 — 실패한 카드는 제 시각이 오기 전까지 뜨거운 큐에서 빠져 있는다
    deferCount: { lt: MAX_DEFER_ATTEMPTS },
    AND: [
      { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      // 키셋 커서 — 정렬 키 (deadline, id)보다 뒤에 있는 것만
      ...(after
        ? [
            {
              OR: [
                { deadline: { gt: after.deadline } },
                { deadline: after.deadline, id: { gt: after.id } },
              ],
            },
          ]
        : []),
    ],
  };

  // **한 번에 다 하지 않는다** (JUDGE_BATCH_SIZE 주석 참고). 오래된 시한부터 —
  // 이월이 길어진 카드가 뒤로 밀리면 돈이 묶인 채 계속 밀린다.
  //
  // **커서로 앞으로 나아간다.** 이월된 카드는 Judgment가 안 생겨 다음 조회에도 그대로
  // 잡히므로, 커서 없이 take만 쓰면 오래된 이월 20장이 앞자리를 영구히 차지한다.
  // 정렬에 id를 더한 이유도 같다 — 시한이 같은 카드가 여럿이면 순서가 흔들려
  // 커서가 어떤 카드를 건너뛸 수 있다.
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
    orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    take: JUDGE_BATCH_SIZE,
  });

  // 같은 종목의 만기 카드가 여러 장이면 조회는 한 번이면 된다 (memoRegistry)
  const quotes = memoizeRegistry(registry);

  const summary: BatchSummary = {
    judged: 0,
    deferred: 0,
    failed: 0,
    staleDeferred: [],
    cursor:
      dueCards.length > 0
        ? {
            deadline: dueCards[dueCards.length - 1].deadline,
            id: dueCards[dueCards.length - 1].id,
          }
        : null,
    hasMore: dueCards.length === JUDGE_BATCH_SIZE,
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
        // **다음 시도를 뒤로 민다.** 이 한 줄이 없으면 실패하는 카드가 매 회차
        // 앞자리를 차지해 KIS 호출을 갉아먹고 뒤의 멀쩡한 카드까지 느려진다
        const deferCount = card.deferCount + 1;
        await prisma.predictionCard.update({
          where: { id: card.id },
          data: { deferCount, nextAttemptAt: nextAttemptAfterDefer(deferCount, now) },
        });
        const staleDays = (now.getTime() - card.deadline.getTime()) / 86_400_000;
        // 자동 재시도를 다 쓴 카드는 **날짜와 무관하게** 사람에게 넘긴다 —
        // 시한 직후에 연달아 실패한 카드가 7일을 기다릴 이유가 없다
        if (deferCount >= MAX_DEFER_ATTEMPTS || staleDays >= STALE_DEFER_DAYS) {
          summary.staleDeferred.push(
            `${card.ticker} (${card.id}, ${deferCount}회 이월): ${e.message}`,
          );
        }
      } else {
        summary.failed++;
        console.error(`판정 실패 ${card.ticker} (${card.id}):`, e);
      }
    }
  }

  return summary;
}
