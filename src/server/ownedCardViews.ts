import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import { toMarketDateString } from '@/domain/marketData';
import { magnitudePctToTargetPrice } from '@/domain/scoring';
import { createDefaultRegistry } from '@/infra/marketData/registry';

// 구매한 카드의 **공개 뷰모델** — MarketCard와 별개로 두는 것이 마스킹의 핵심이다.
//
// MarketCard에 종목·목표 원값을 얹고 화면에서 가리는 방식이었다면, 목록에 있는 모든
// 카드의 정답이 클라이언트로 나간다. 그래서 이 조회는 **내가 산 리포트 id로 먼저 좁히고**
// 그 안에서만 종목·목표를 싣는다. 안 산 카드의 데이터는 서버 밖으로 나갈 경로가 없다.
//
// 현재가도 여기서 함께 붙인다. 대상이 "내가 산 카드"로 이미 좁혀져 있어 호출량이
// 사람 수가 아니라 보유 수에 비례한다 — 목록 전체에 시세를 붙이는 것과 비용이 다르다.

export interface OwnedCardView {
  reportId: string;
  title: string;
  /** 누가 쓴 예측인가 — 산 뒤에도 책임 주체는 남아야 한다 */
  researcherName: string;
  careerBadge: string | null;
  assetClass: string;
  assetName: string;
  ticker: string;
  currency: string;
  direction: string;
  targetType: string;
  targetValue: number;
  basePrice: number | null;
  targetPrice: number | null;
  deadline: Date;
  publishedAt: Date | null;
  priceKrw: number;
  /** 조회 시점 시세 — 공급자가 없거나 실패하면 null (막대가 시간 전용으로 내려간다) */
  currentPrice: number | null;
  /** 판정이 끝난 카드는 진행이 아니라 결과다 */
  judged: boolean;
}

// ── 시세 캐시 ────────────────────────────────────────────────
// 화면 한 번에 같은 종목이 여러 번 나오고(카드·레일·검색) 새로고침도 잦다.
// 60초 캐시로 "같은 화면 안에서는 한 번"이 보장된다. 판정용 시세가 아니므로
// 약간 지난 값이어도 무해하다 — 판정은 시한 시점 확정 시세로만 이뤄진다.
const PRICE_TTL_MS = 60_000;
const priceCache = new Map<string, { at: number; price: number | null }>();

async function fetchPrice(assetClass: string, ticker: string): Promise<number | null> {
  const key = `${assetClass}:${ticker}`;
  const hit = priceCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.price;

  let price: number | null = null;
  try {
    const provider = createDefaultRegistry()[assetClass as AssetClass];
    if (provider) {
      if (provider.getCurrentPrice) {
        price = await provider.getCurrentPrice(ticker);
      } else {
        // 실시간을 안 주는 소스(주식)는 최근 종가로 대신한다 — 장중 값은 아니지만
        // "지금 어디쯤"의 답으로는 충분하고, 판정 시세와 혼동될 여지도 적다
        const to = toMarketDateString(new Date(), assetClass as AssetClass);
        const from = toMarketDateString(
          new Date(Date.now() - 10 * 86_400_000),
          assetClass as AssetClass,
        );
        const quotes = await provider.getDailyQuotes(ticker, from, to);
        price = quotes.length > 0 ? quotes[quotes.length - 1].close : null;
      }
    }
  } catch {
    // 시세 장애는 화면을 죽이지 않는다 — 막대가 시간 전용으로 내려갈 뿐이다
    price = null;
  }

  priceCache.set(key, { at: now, price });
  return price;
}

/**
 * 내가 산 카드들의 공개 뷰 — 목록에서 소유 카드를 다른 구성으로 그리는 데 쓴다.
 * reportIds를 함께 받아 "지금 화면에 있는 것"만 조회한다(보유 전체가 아니라).
 */
export async function getOwnedCardViews(
  prisma: PrismaClient,
  buyerId: string | null,
  reportIds: string[],
): Promise<Map<string, OwnedCardView>> {
  const out = new Map<string, OwnedCardView>();
  if (!buyerId || reportIds.length === 0) return out;

  const purchases = await prisma.purchase.findMany({
    where: { buyerId, reportId: { in: reportIds } },
    select: {
      report: {
        select: {
          id: true,
          title: true,
          priceKrw: true,
          publishedAt: true,
          researcher: {
            select: {
              careerBadge: true,
              user: { select: { penName: true, email: true } },
            },
          },
          predictionCard: {
            select: {
              assetClass: true,
              assetName: true,
              ticker: true,
              currency: true,
              direction: true,
              targetType: true,
              targetValue: true,
              basePrice: true,
              deadline: true,
              judgment: { select: { id: true } },
            },
          },
        },
      },
    },
  });

  const rows = purchases.flatMap((p) => (p.report.predictionCard ? [p.report] : []));

  // 종목 단위로 한 번씩만 조회 — 같은 종목 카드를 여러 장 샀어도 호출은 하나다
  const tickers = new Map<string, { assetClass: string; ticker: string }>();
  for (const r of rows) {
    const c = r.predictionCard!;
    tickers.set(`${c.assetClass}:${c.ticker}`, { assetClass: c.assetClass, ticker: c.ticker });
  }
  const priceEntries = await Promise.all(
    [...tickers.values()].map(async (t) => {
      const price = await fetchPrice(t.assetClass, t.ticker);
      return [`${t.assetClass}:${t.ticker}`, price] as const;
    }),
  );
  const prices = new Map(priceEntries);

  for (const r of rows) {
    const c = r.predictionCard!;
    const targetPrice =
      c.targetType === 'TARGET_PRICE'
        ? c.targetValue
        : c.basePrice != null
          ? magnitudePctToTargetPrice(c.basePrice, c.direction as Direction, c.targetValue)
          : null;

    out.set(r.id, {
      reportId: r.id,
      title: r.title,
      researcherName: r.researcher.user.penName ?? r.researcher.user.email,
      careerBadge: r.researcher.careerBadge,
      assetClass: c.assetClass,
      assetName: c.assetName,
      ticker: c.ticker,
      currency: c.currency,
      direction: c.direction,
      targetType: c.targetType,
      targetValue: c.targetValue,
      basePrice: c.basePrice,
      targetPrice,
      deadline: c.deadline,
      publishedAt: r.publishedAt,
      priceKrw: r.priceKrw,
      currentPrice: prices.get(`${c.assetClass}:${c.ticker}`) ?? null,
      judged: c.judgment !== null,
    });
  }
  return out;
}
