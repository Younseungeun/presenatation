import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import { resolveProvider, type ProviderRegistry } from '@/domain/marketData';
import { decideWatch, watchPriority } from '@/domain/quoteWatch';
import { remainingFraction } from '@/domain/salesWindow';
import { magnitudePctToTargetPrice, targetPriceToMagnitudePct } from '@/domain/scoring';

// 시세 감시 — 문턱 근처 종목의 스냅샷을 장중에 갱신한다 (설계: domain/quoteWatch.ts).
//
// 세 곳에서 스냅샷이 채워진다. 셋 다 **이미 일어나는 일에 얹는다** — 감시를 위해
// 새로 시세를 부르는 것은 감시 대상뿐이다:
//   ① 판정 배치가 받은 일봉 종가 (추가 호출 0)
//   ② 결제 전 실시간 호출 (사용자 확정) — 감시 밖 종목이 문턱에 다가온 것을
//      "사려는 사람"이 발견해 준다. 발견 즉시 감시로 편입된다
//   ③ 장중 갱신 배치 — 감시 대상만

/** 한 카드의 q를 구하는 데 필요한 최소 정보 */
export interface QuotableCard {
  direction: string;
  targetType: string;
  targetValue: number;
  basePrice: number | null;
}

/**
 * 카드 하나의 q (남은 몫 ÷ 광고 폭). 기준가·크기가 없으면 null —
 * 소급 확정 대기 카드(기준가 미정)는 판단 대상이 아니다.
 */
export function cardQ(card: QuotableCard, price: number): number | null {
  if (card.basePrice == null || card.basePrice <= 0 || price <= 0) return null;
  const direction = card.direction as Direction;
  const magnitudePct =
    card.targetType === 'RETURN_PCT'
      ? card.targetValue
      : targetPriceToMagnitudePct(card.targetValue, card.basePrice);
  if (!(magnitudePct > 0)) return null;
  const targetPrice =
    card.targetType === 'TARGET_PRICE'
      ? card.targetValue
      : magnitudePctToTargetPrice(card.basePrice, direction, card.targetValue);
  return remainingFraction(direction, price, targetPrice, magnitudePct);
}

/** 그 종목의 판매 중 카드들 중 가장 문턱에 가까운 q */
function minQOf(cards: QuotableCard[], price: number): number | null {
  const qs = cards.map((c) => cardQ(c, price)).filter((q): q is number => q !== null);
  return qs.length > 0 ? Math.min(...qs) : null;
}

/** 지금 판매 중인(=목록에 뜨는) 카드만 — 판정·마감된 카드는 감시할 이유가 없다 */
async function sellableCardsOf(prisma: PrismaClient, assetClass: string, ticker: string, now: Date) {
  return prisma.predictionCard.findMany({
    where: {
      assetClass,
      ticker,
      judgment: null,
      withdrawnAt: null,
      deadline: { gt: now },
      report: { status: 'PUBLISHED', salesClosedAt: null },
    },
    select: { direction: true, targetType: true, targetValue: true, basePrice: true },
  });
}

/**
 * 시세 하나를 스냅샷에 반영하고 감시 여부를 갱신한다.
 * 결제 관문·배치가 공유하는 단일 입구 — 어디서 들어온 시세든 같은 규칙으로 처리된다.
 */
export async function recordQuote(
  prisma: PrismaClient,
  assetClass: string,
  ticker: string,
  price: number,
  source: 'batch' | 'gate' | 'refresh',
  now = new Date(),
): Promise<{ minQ: number | null; watching: boolean }> {
  if (!(price > 0)) return { minQ: null, watching: false };

  const [cards, existing] = await Promise.all([
    sellableCardsOf(prisma, assetClass, ticker, now),
    prisma.instrumentQuote.findUnique({ where: { assetClass_ticker: { assetClass, ticker } } }),
  ]);
  const minQ = minQOf(cards, price);
  const { watching } = decideWatch({
    minQ,
    wasWatching: existing?.watching ?? false,
    snapshotAt: now,
    now,
  });

  await prisma.instrumentQuote.upsert({
    where: { assetClass_ticker: { assetClass, ticker } },
    create: { assetClass, ticker, price, at: now, watching, minQ, source },
    update: { price, at: now, watching, minQ, source },
  });
  return { minQ, watching };
}

export interface QuoteRefreshSummary {
  watched: number;
  refreshed: number;
  released: number;
  failed: number;
}

/**
 * 장중 갱신 배치 — **감시 대상만** 다시 부른다 (npm run batch:quotes).
 *
 * 문턱에 가까운 종목부터 처리한다: 호출이 초당 1회로 직렬화돼 있어, 예산이 모자라는
 * 상황에서도 중요한 종목이 먼저 신선해져야 한다.
 */
export async function refreshWatchedQuotes(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
  limit = 60,
): Promise<QuoteRefreshSummary> {
  const watched = await prisma.instrumentQuote.findMany({ where: { watching: true } });
  const summary: QuoteRefreshSummary = {
    watched: watched.length,
    refreshed: 0,
    released: 0,
    failed: 0,
  };

  const ordered = [...watched].sort(
    (a, b) => watchPriority(a.minQ ?? 99) - watchPriority(b.minQ ?? 99),
  );

  for (const row of ordered.slice(0, limit)) {
    const assetClass = row.assetClass as AssetClass;
    try {
      const provider = resolveProvider(registry, assetClass);
      if (!provider.getCurrentPrice) continue;
      const price = await provider.getCurrentPrice(row.ticker);
      const { watching } = await recordQuote(prisma, row.assetClass, row.ticker, price, 'refresh', now);
      summary.refreshed++;
      if (!watching) summary.released++;
    } catch {
      // 시세 장애로 감시를 풀지 않는다 — 다음 회차에 다시 본다
      summary.failed++;
    }
  }
  return summary;
}

/**
 * 일봉 종가로 감시 후보를 채운다 — 판정 배치가 **이미 받은 값**을 쓰므로 호출이 없다.
 * 장이 닫힌 사이에 문턱 근처로 온 종목이 다음 장중 갱신 대상으로 들어오는 경로다.
 */
export async function seedWatchFromClose(
  prisma: PrismaClient,
  assetClass: string,
  ticker: string,
  close: number,
  now = new Date(),
): Promise<void> {
  await recordQuote(prisma, assetClass, ticker, close, 'batch', now);
}
