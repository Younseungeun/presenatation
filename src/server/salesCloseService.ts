import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import { toMarketDateString, type ProviderRegistry } from '@/domain/marketData';
import { cardProfitabilityLevel } from '@/domain/profitability';
import {
  closesAtDailyClose,
  remainingReturnPct,
  salesWindowEnd,
  type SalesCloseReason,
} from '@/domain/salesWindow';
import { magnitudePctToTargetPrice } from '@/domain/scoring';
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

  // 종가는 종목 단위로 한 번만 조회
  const closeCache = new Map<string, number | null>();
  async function latestClose(assetClass: string, ticker: string): Promise<number | null> {
    const key = `${assetClass}:${ticker}`;
    if (closeCache.has(key)) return closeCache.get(key)!;
    let close: number | null = null;
    try {
      const provider = registry[assetClass as AssetClass];
      if (provider) {
        const to = toMarketDateString(now, assetClass as AssetClass);
        const from = toMarketDateString(
          new Date(now.getTime() - 10 * 86_400_000),
          assetClass as AssetClass,
        );
        const quotes = await provider.getDailyQuotes(ticker, from, to);
        close = quotes.length > 0 ? quotes[quotes.length - 1].close : null;
      }
    } catch {
      close = null;
    }
    closeCache.set(key, close);
    return close;
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
    const close = await latestClose(card.assetClass, card.ticker);
    if (close === null) {
      result.skipped.push({ reportId: r.id, cause: 'NO_QUOTE' });
      continue;
    }
    const targetPrice =
      card.targetType === 'TARGET_PRICE'
        ? card.targetValue
        : magnitudePctToTargetPrice(card.basePrice, card.direction as Direction, card.targetValue);
    const remaining = remainingReturnPct(card.direction as Direction, close, targetPrice);
    if (closesAtDailyClose(card.assetClass as AssetClass, level, remaining)) {
      await closeSales(prisma, r.id, r.researcher.userId, 'BAND_EXIT', now);
      result.closed.push({ reportId: r.id, reason: 'BAND_EXIT' });
    }
  }

  return result;
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
        body:
          reason === 'BAND_EXIT'
            ? '목표까지 남은 폭이 보장선(구간 최소치의 2/3) 밑으로 내려가 판매가 자동 마감되었습니다. 카드는 그대로 검증되어 시한에 판정됩니다.'
            : '판매 기간(검증 기간의 1/3, 최대 30일)이 끝나 판매가 마감되었습니다. 카드는 그대로 검증되어 시한에 판정됩니다.',
        link: `/report/${reportId}`,
      },
    }),
  ]);
}
