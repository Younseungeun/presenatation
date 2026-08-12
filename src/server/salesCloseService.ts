import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import {
  resolveProvider,
  toMarketDateString,
  type ProviderRegistry,
} from '@/domain/marketData';
import {
  adverseMoveFraction,
  closesOnAdverseMove,
  isSalesWindowOpen,
  salesWindowEnd,
  type SalesCloseReason,
} from '@/domain/salesWindow';
import { targetPriceToMagnitudePct } from '@/domain/scoring';
import { memoizeRegistry } from '@/infra/marketData/memoRegistry';

// 판매 마감 배치 — 하루 1회 이상 (npm run batch:salesclose).
//
// 여기서 닫는 것은 **판매**이지 카드가 아니다: 카드는 살아서 판정되고,
// 기존 구매자·히트맵·컨센서스는 아무 영향이 없다.
//
// 이 배치가 집행하는 것은 둘이다:
//   · WINDOW_END(시간) — 게시일·시한만으로 결정된다. 관문들이 계산으로 이미 즉시
//     집행하므로(isSalesWindowOpen) 여기서의 역할은 **기록**과 **리서처 알림**이다.
//   · ADVERSE_MOVE(가격, 2026-08-12 추가) — 기준가에서 목표 폭만큼 반대로 간 카드.
//     **일봉 종가로만** 판정한다. 불가역 처분이라 장중 시세로 하면 순간 꼬리 한 번으로
//     남의 판매를 영구히 죽일 수 있다(적중 판정이 종가만 보는 것과 같은 이유).
//     장중 보호는 결제 관문이 따로 맡되 기록은 남기지 않는다(purchaseService).
//
// 여기서 닫지 않는 것:
//   · 목표 도달 → **판정**이 일어나고, 판정된 카드는 팔 수 없으므로 판매도 그 순간
//     끝난다 — 도달 판정 배치(reachedJudgmentBatch)의 몫이다
//   · 목표에 근접(q < 1/2) → 결제 관문의 **가역적 중단**. 시세가 돌아오면 다시 팔린다

/** 리서처에게만 가는 사유 안내 — 구매자에게는 사유 없이 "판매 마감" 한 줄이다 */
const CLOSE_NOTICE: Record<SalesCloseReason, string> = {
  WINDOW_END:
    '판매 기간(검증 기간의 1/3, 최대 30일)이 끝나 판매가 마감되었습니다. 카드는 그대로 검증되어 판정됩니다.',
  RESEARCHER:
    '요청하신 대로 판매를 마감했습니다. 다시 열 수 없습니다. 카드는 그대로 검증되어 판정되고, 기존 구매자의 환불 조건도 변하지 않습니다.',
  ADVERSE_MOVE:
    '일봉 종가가 기준가에서 목표 폭만큼 반대로 움직여 판매가 마감되었습니다. 카드는 그대로 검증되어 시한에 판정되며, 시세가 돌아와도 판매는 다시 열리지 않습니다.',
};

/** 역방향 마감 판정에 쓸 최신 종가를 구한다 — 없으면 null (그 카드는 이번 회차 건너뜀) */
async function latestClose(
  quotes: ProviderRegistry,
  assetClass: AssetClass,
  ticker: string,
  now: Date,
): Promise<number | null> {
  const to = toMarketDateString(now, assetClass);
  // 연휴·거래정지로 최근 며칠이 비어 있을 수 있어 넉넉히 열흘을 본다
  const from = toMarketDateString(new Date(now.getTime() - 10 * 86_400_000), assetClass);
  const rows = await resolveProvider(quotes, assetClass).getDailyQuotes(ticker, from, to);
  return rows.length > 0 ? rows[rows.length - 1].close : null;
}

export interface SalesCloseResult {
  checked: number;
  closed: { reportId: string; reason: SalesCloseReason }[];
}

export async function runSalesCloseBatch(
  prisma: PrismaClient,
  now = new Date(),
  /**
   * 시세 공급자 — 주면 역방향 마감(ADVERSE_MOVE)까지 집행한다.
   * 없으면 시간 규칙만 (시세 없이도 돌 수 있어야 하는 자리라 선택 인자다).
   */
  registry?: ProviderRegistry,
): Promise<SalesCloseResult> {
  const candidates = await prisma.report.findMany({
    where: {
      status: 'PUBLISHED',
      salesClosedAt: null,
      predictionCard: { is: { deadline: { gt: now }, withdrawnAt: null, judgment: null } },
    },
    select: {
      id: true,
      publishedAt: true,
      researcher: { select: { userId: true } },
      predictionCard: {
        select: {
          deadline: true,
          assetClass: true,
          ticker: true,
          direction: true,
          targetType: true,
          targetValue: true,
          basePrice: true,
        },
      },
    },
  });

  const result: SalesCloseResult = { checked: candidates.length, closed: [] };
  // 종목 단위 캐시 — 같은 종목 카드가 몇 장이든 시세 호출은 한 번
  const quotes = registry ? memoizeRegistry(registry) : null;

  for (const r of candidates) {
    const card = r.predictionCard!;
    if (r.publishedAt && now >= salesWindowEnd(r.publishedAt, card.deadline)) {
      await closeSales(prisma, r.id, r.researcher.userId, 'WINDOW_END', now);
      result.closed.push({ reportId: r.id, reason: 'WINDOW_END' });
      continue;
    }

    // ── 역방향 마감 — **일봉 종가로만 판정한다.**
    // 이 마감은 불가역이라 장중 시세로 판정하면 순간 꼬리(wick) 한 번으로 남의 판매를
    // 영구히 죽일 수 있다. 적중 판정이 종가만 보는 것과 같은 이유다.
    if (!quotes || card.basePrice == null || card.basePrice <= 0) continue;
    const magnitudePct =
      card.targetType === 'RETURN_PCT'
        ? card.targetValue
        : targetPriceToMagnitudePct(card.targetValue, card.basePrice);
    if (magnitudePct <= 0) continue;

    try {
      const close = await latestClose(quotes, card.assetClass as AssetClass, card.ticker, now);
      if (close === null || close <= 0) continue;
      const adverse = adverseMoveFraction(
        card.direction as Direction,
        card.basePrice,
        close,
        magnitudePct,
      );
      if (closesOnAdverseMove(adverse)) {
        await closeSales(prisma, r.id, r.researcher.userId, 'ADVERSE_MOVE', now);
        result.closed.push({ reportId: r.id, reason: 'ADVERSE_MOVE' });
      }
    } catch {
      // 시세 장애로 마감을 **지어내지 않는다** — 다음 회차에 다시 본다.
      // (불가역 처분이라 불확실할 때 실행하지 않는 쪽이 안전하다)
      continue;
    }
  }

  return result;
}

/**
 * 리서처 자발 판매 단축 — 본인이 판매를 일찍 닫는다. **회수 불가.**
 *
 * 촉매형 리포트(실적 발표·이벤트 직전)는 논지가 소비되는 시점이 정해져 있는데
 * 시스템의 1/3 규칙은 그 시점을 모른다. 촉매가 지난 뒤에도 계속 팔리면
 * "이미 끝난 논지를 판 사람"이 되어 평판이 깎인다.
 *
 * **되돌릴 수 없게 만든 것이 이 기능의 핵심이다.** 판매 수익을 스스로 포기하는 행위라
 * 실력 없는 사람은 흉내낼 이유가 없는 정직 신호인데, 재개가 가능하면 비용이 0이 되어
 * 신호가 죽는다(닫았다 열었다 하며 희소성만 연출하게 된다).
 *
 * 사유는 구매자에게 공개하지 않는다 — 다른 마감과 똑같이 "판매 마감" 한 줄이다.
 * "리서처가 직접 닫았다"가 보이면 촉매 임박 신호가 되어 종목 역산을 돕는다.
 */
export async function closeSalesByResearcher(
  prisma: PrismaClient,
  reportId: string,
  requesterUserId: string,
  now = new Date(),
): Promise<void> {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    select: {
      status: true,
      publishedAt: true,
      salesClosedAt: true,
      researcher: { select: { userId: true } },
      predictionCard: { select: { deadline: true, withdrawnAt: true } },
    },
  });

  if (report.researcher.userId !== requesterUserId) {
    throw new Error('본인이 쓴 리포트만 판매를 마감할 수 있습니다');
  }
  if (report.status !== 'PUBLISHED') {
    throw new Error('판매 중인 리포트가 아닙니다');
  }
  if (!report.predictionCard || report.predictionCard.withdrawnAt) {
    throw new Error('예측 카드가 없거나 철회된 리포트입니다');
  }
  if (report.salesClosedAt) {
    throw new Error('이미 판매가 마감된 리포트입니다');
  }
  // 시스템 규칙으로 이미 닫혀 있어야 할 카드에 "리서처가 닫았다"를 덧씌우지 않는다 —
  // 기록이 사실과 달라지면 나중에 정직 신호를 집계할 때 셈이 틀린다
  if (!isSalesWindowOpen(report.publishedAt, report.predictionCard.deadline, now)) {
    throw new Error('판매 기간이 이미 끝난 리포트입니다');
  }

  await closeSales(prisma, reportId, report.researcher.userId, 'RESEARCHER', now);
}

async function closeSales(
  prisma: PrismaClient,
  reportId: string,
  researcherUserId: string,
  reason: SalesCloseReason,
  now: Date,
): Promise<void> {
  await prisma.$transaction([
    prisma.report.update({
      where: { id: reportId },
      data: { salesClosedAt: now, salesCloseReason: reason },
    }),
    // 리서처 통지 — 왜 안 팔리는지 몰라야 할 이유가 없다.
    // 사유 상세는 본인에게만 간다(목록·상세의 공개 문구는 "판매 마감" 하나로 통일)
    prisma.notification.create({
      data: {
        userId: researcherUserId,
        type: 'SALES_CLOSED',
        title: '카드 판매가 마감되었습니다',
        body: CLOSE_NOTICE[reason],
        link: `/report/${reportId}`,
      },
    }),
  ]);
}
