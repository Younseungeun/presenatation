import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import {
  MARKET_TIMEZONE,
  marketClock,
  nextDateString,
  toMarketDateString,
  type ProviderRegistry,
} from '@/domain/marketData';
import { EQUITY_REGULAR_CLOSE } from '@/domain/publishReport';
import { minMagnitudePct, targetPriceToMagnitudePct } from '@/domain/scoring';
import { memoizeRegistry } from '@/infra/marketData/memoRegistry';

// 게시일 마감 종가로 기준가를 확정하고 판매를 여는 배치 (DAY_CLOSE_AT_CLOSE, 2026-08-29).
// npm run batch:confirmbase — 마감+5분에 시장별로, 도달·기한 판정 배치보다 **먼저** 돈다
// (기준가가 확정돼야 그 카드가 판매·판정 대상이 되기 때문).
//
// 장중·장후 게시 <14일 주식 카드는 게시 순간엔 기준가(종가)가 없어 **목표가로만** 쓰고
// 판매를 안 열어 두었다. 이 배치가 게시 이후 첫 정규장 종가로 기준가를 확정한다:
//  · 종가가 아직 없으면(오늘 아직 마감 전이거나 데이터 미도달) 다음 회차로 미룬다
//  · 목표가가 확정 기준가 대비 방향이 맞고 크기 하한을 넘으면 → 기준가·판매 시작 시각
//    (baseConfirmedAt)을 적어 **판매를 연다.** 판매 기간·판정은 이 기준가로 이뤄진다
//  · 방향이 어긋나거나(예측이 성립 안 함) 하한 미달이면 → **철회**한다. 판매가 시작되기
//    전이라 구매자가 없어 환불이 없고, 리서처에게 사유를 통지한다
//
// 기준가는 리서처가 고를 수 없는 **종가**라, 게시 시각으로 목표선을 당기는 이점이 없다.
//
// ⚠ **게시 후 마감까지 이미 목표를 지나쳤으면 무효로 처리한다** (자유 적중을 만들지 않음).
//   기준가가 그 이동을 흡수하므로 기준가에서 목표까지 움직일 여지가 없다 = 예측이 아니다.
//   창업자 초안(rec #3)은 그 경우 "즉시 적중"이었으나, 그건 게시 시각에 이미 일어난
//   등락에 점수를 주는 것이라(막으려던 바로 그 누수) 방향 위반과 함께 무효로 둔다.

export interface DelayedBaseSummary {
  checked: number;
  /** 기준가 확정 + 판매 오픈 */
  confirmed: number;
  /** 방향 위반·하한 미달로 철회 */
  invalidated: number;
  /** 아직 확정 종가가 없어 다음 회차로 미룸 */
  notYet: number;
  failed: number;
}

export async function confirmDelayedBaseBatch(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
  /** 자산군 스코프 — 시장별로 마감 직후 그 시장만 (없으면 전부) */
  assetClass?: AssetClass,
): Promise<DelayedBaseSummary> {
  const cards = await prisma.predictionCard.findMany({
    where: {
      baseMode: 'DAY_CLOSE_AT_CLOSE',
      basePrice: null,
      baseConfirmedAt: null,
      withdrawnAt: null,
      judgment: null,
      ...(assetClass ? { assetClass } : {}),
      report: { status: 'PUBLISHED', publishedAt: { not: null } },
    },
    include: { report: { include: { researcher: { select: { userId: true } } } } },
    orderBy: { createdAt: 'asc' },
  });

  const quotes = memoizeRegistry(registry);
  const summary: DelayedBaseSummary = {
    checked: cards.length,
    confirmed: 0,
    invalidated: 0,
    notYet: 0,
    failed: 0,
  };

  for (const card of cards) {
    try {
      const ac = card.assetClass as AssetClass;
      const provider = quotes[ac];
      if (!provider) {
        summary.failed++;
        continue;
      }
      const publishedAt = card.report.publishedAt!;
      const publishDate = toMarketDateString(publishedAt, ac);
      // 기준일 = 게시 이후 첫 정규장 종가의 날짜. 정규장 마감 후 게시라면 그날 종가는 이미
      // 공개된 과거이므로 다음 거래일로 굴린다 (판정 파이프라인 DAY_CLOSE 분기와 같은 규칙).
      const closeTime = EQUITY_REGULAR_CLOSE[ac as 'KR_EQUITY' | 'US_EQUITY'];
      const clock = marketClock(publishedAt, MARKET_TIMEZONE[ac]);
      const baseFromDate = clock.time <= closeTime ? publishDate : nextDateString(publishDate);
      const todayDate = toMarketDateString(now, ac);
      if (baseFromDate > todayDate) {
        summary.notYet++;
        continue;
      }

      const candles = await provider.getDailyQuotes(card.ticker, baseFromDate, todayDate);
      const baseCandle = candles.find((q) => q.date >= baseFromDate);
      if (!baseCandle) {
        // 아직 그 거래일 종가가 없다(오늘 마감 전이거나 데이터 미도달) — 다음 회차
        summary.notYet++;
        continue;
      }

      const base = baseCandle.close;
      const dir = card.direction as Direction;
      const target = card.targetValue;
      const wrongDirection = (dir === 'UP' && target <= base) || (dir === 'DOWN' && target >= base);
      const magnitude = Math.abs(targetPriceToMagnitudePct(target, base));
      const horizonDays = (card.deadline.getTime() - publishedAt.getTime()) / 86_400_000;
      const floor = minMagnitudePct(ac, card.sigmaDaily, horizonDays);

      if (wrongDirection || magnitude < floor) {
        const reason = wrongDirection
          ? `기준가(${base})가 확정되니 목표가(${target})가 예측 방향과 어긋납니다`
          : `기준가(${base}) 대비 목표 크기 ${magnitude.toFixed(1)}%가 하한 ${floor.toFixed(1)}% 미만입니다`;
        await prisma.$transaction([
          prisma.predictionCard.update({ where: { id: card.id }, data: { withdrawnAt: now } }),
          prisma.notification.create({
            data: {
              userId: card.report.researcher.userId,
              type: 'PUBLISH_INVALIDATED',
              title: `게시 무효: ${card.assetName}`,
              body:
                `장 마감 후 기준가가 확정되면서 이 카드를 게시 취소했습니다 — ${reason}. ` +
                `판매가 시작되기 전이라 구매·환불은 없습니다. 목표가를 조정해 다시 게시해 주세요.`,
            },
          }),
        ]);
        summary.invalidated++;
        continue;
      }

      // 유효 — 기준가 확정 + 판매 오픈. 앵커도 함께 적어 이후 권리 사건 감지에 쓴다.
      await prisma.predictionCard.update({
        where: { id: card.id },
        data: {
          basePrice: base,
          baseConfirmedAt: now,
          baseCloseAnchor: base,
          baseCloseAnchorDate: baseCandle.date,
        },
      });
      summary.confirmed++;
    } catch (e) {
      summary.failed++;
      console.error(`기준가 확정 실패 ${card.ticker} (${card.id}):`, e);
    }
  }

  return summary;
}
