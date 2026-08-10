import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import { toMarketDateString, type DailyQuote, type ProviderRegistry } from '@/domain/marketData';
import { cardProfitabilityLevel } from '@/domain/profitability';
import {
  closesAtDailyClose,
  isSalesWindowOpen,
  remainingReturnPct,
  salesWindowEnd,
  SALES_WINDOW_MAX_DAYS,
  type SalesCloseReason,
} from '@/domain/salesWindow';
import { magnitudePctToTargetPrice } from '@/domain/scoring';
import { memoizeRegistry } from '@/infra/marketData/memoRegistry';
import { createDefaultRegistry } from '@/infra/marketData/registry';

// 판매 마감 배치 — 하루 1회 이상 (npm run batch:salesclose).
//
// 여기서 닫는 것은 **판매**이지 카드가 아니다: 카드는 살아서 시한에 정상 판정되고,
// 기존 구매자·히트맵·컨센서스는 아무 영향이 없다.
//
// 가격 규칙(BAND_EXIT)은 **일봉 종가만** 본다:
//  · 순간 꼬리(wick) 하나로 판매가 죽으면 시세를 튀겨 남의 판매를 끄는 조작 통로가 된다
//  · 종가는 소급 수집이 되므로 API가 하루 막혀도 다음 날 그 날짜 종가로 정확히 판정된다
//  · 판정 엔진과 같은 공급자를 쓰므로 "화면 따로 판정 따로" 불일치가 없다
// 장중 보호는 결제 관문(purchaseService)의 1/2선 검사가 맡는다 — 피해자는 구매하는
// 순간에 생기므로 검사도 그 순간에 한다.
//
// 시세 조회 실패는 그 카드를 이번 회차에서 건너뛴다 — 마감은 하루 늦어질 수 있지만
// 장애가 멀쩡한 카드를 닫아 버리는 것보다 낫다(결제 관문이 그 사이를 지킨다).

/** 리서처에게만 가는 사유 안내 — 구매자에게는 사유 없이 "판매 마감" 한 줄이다 */
const CLOSE_NOTICE: Record<SalesCloseReason, string> = {
  BAND_EXIT:
    '목표까지 남은 폭이 보장선(구간 최소치의 2/3) 밑으로 내려가 판매가 자동 마감되었습니다. 카드는 그대로 검증되어 시한에 판정됩니다.',
  WINDOW_END:
    '판매 기간(검증 기간의 1/3, 최대 30일)이 끝나 판매가 마감되었습니다. 카드는 그대로 검증되어 시한에 판정됩니다.',
  RESEARCHER:
    '요청하신 대로 판매를 마감했습니다. 다시 열 수 없습니다. 카드는 그대로 검증되어 시한에 판정되고, 기존 구매자의 환불 조건도 변하지 않습니다.',
};

export interface SalesCloseResult {
  checked: number;
  closed: { reportId: string; reason: SalesCloseReason }[];
  skipped: { reportId: string; cause: string }[];
}

export async function runSalesCloseBatch(
  prisma: PrismaClient,
  now = new Date(),
  registry: ProviderRegistry = createDefaultRegistry(),
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
          assetClass: true,
          ticker: true,
          direction: true,
          targetType: true,
          targetValue: true,
          basePrice: true,
          deadline: true,
          confidence: true, // cardProfitabilityLevel 입력 형과 무관하지만 명시적 유지
        },
      },
    },
  });

  const result: SalesCloseResult = { checked: candidates.length, closed: [], skipped: [] };

  // 시세 조회는 **종목 단위**다 — 같은 종목 카드가 몇 장이든 공급자 호출은 한 번.
  // 판정 배치와 같은 장치(memoizeRegistry)를 쓴다: 종목 단위 캐시를 여기저기
  // 손으로 만들면 구현이 갈라지고, 갈라지면 한쪽만 고치는 사고가 난다.
  //
  // **마지막 종가가 아니라 판매 기간 전체의 종가를 본다.** 규칙은 "잔여가 마감선 밑인
  // 종가가 *찍히면* 마감"이지 "오늘 종가가 밑이면"이 아니다. 마지막 것만 보면 배치가
  // 하루라도 밀린 사이에 뚫었다가 회복한 카드가 그냥 살아남는다 —
  // 그 사이에 산 구매자에게 한 보장("구간 최소치의 2/3는 남아 있다")이 깨진 채로.
  //
  // 조회 범위가 무한정 늘지는 않는다: 판매 기간은 최대 30일이고 그 전에 WINDOW_END로
  // 닫히므로, 아직 판매 중인 카드의 게시일은 항상 30일 이내다.
  const memo = memoizeRegistry(registry);
  async function closesSincePublish(
    assetClass: string,
    ticker: string,
  ): Promise<DailyQuote[] | null> {
    const provider = memo[assetClass as AssetClass];
    if (!provider) return null;
    try {
      const to = toMarketDateString(now, assetClass as AssetClass);
      const from = toMarketDateString(
        new Date(now.getTime() - (SALES_WINDOW_MAX_DAYS + 1) * 86_400_000),
        assetClass as AssetClass,
      );
      const rows = await provider.getDailyQuotes(ticker, from, to);
      return rows.length > 0 ? rows : null;
    } catch {
      return null;
    }
  }

  for (const r of candidates) {
    const card = r.predictionCard!;

    // ① 시간 규칙 — 게시 + min(검증기간×1/3, 30일)
    if (r.publishedAt && now >= salesWindowEnd(r.publishedAt, card.deadline)) {
      await closeSales(prisma, r.id, r.researcher.userId, 'WINDOW_END', now);
      result.closed.push({ reportId: r.id, reason: 'WINDOW_END' });
      continue;
    }

    // ② 가격 규칙 — 기준가가 아직 없는 카드(소급 확정 대기)는 계산 불가라 쉰다
    if (card.basePrice === null) {
      result.skipped.push({ reportId: r.id, cause: 'NO_BASE_PRICE' });
      continue;
    }
    const level = cardProfitabilityLevel(card);
    if (level === null) {
      result.skipped.push({ reportId: r.id, cause: 'NO_LEVEL' });
      continue;
    }
    const closes = await closesSincePublish(card.assetClass, card.ticker);
    if (closes === null) {
      result.skipped.push({ reportId: r.id, cause: 'NO_QUOTE' });
      continue;
    }
    const targetPrice =
      card.targetType === 'TARGET_PRICE'
        ? card.targetValue
        : magnitudePctToTargetPrice(card.basePrice, card.direction as Direction, card.targetValue);
    // 이 카드의 게시일 이후 종가만 본다 — 게시 전 시세는 이 카드의 판매와 무관하다
    const publishDate = r.publishedAt
      ? toMarketDateString(r.publishedAt, card.assetClass as AssetClass)
      : '';
    const breached = closes.some((q) => {
      if (q.date < publishDate) return false;
      const remaining = remainingReturnPct(card.direction as Direction, q.close, targetPrice);
      return closesAtDailyClose(card.assetClass as AssetClass, level, remaining);
    });
    if (breached) {
      await closeSales(prisma, r.id, r.researcher.userId, 'BAND_EXIT', now);
      result.closed.push({ reportId: r.id, reason: 'BAND_EXIT' });
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
    // 사유 상세는 본인에게만 간다(목록·상세의 공개 문구는 "판매 마감" 하나로 통일 —
    // 사유가 공개되면 자산군·방향·구간과 조합해 종목이 좁혀진다)
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
