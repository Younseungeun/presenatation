import type {
  DailyQuote,
  InstrumentListing,
  MarketDataProvider,
  ProviderRegistry,
  SecurityStatus,
} from '@/domain/marketData';
import type { AssetClass } from '@/domain/constants';

// 배치 1회 동안 쓰는 **종목 단위 시세 캐시.**
//
// 판정 파이프라인(runJudgment)은 카드 하나를 받아 그 카드의 구간을 조회하도록 만들어져
// 있다. 그건 그대로 두는 게 맞다 — 카드 하나를 판정하는 순수한 절차이기 때문이다.
// 대신 **공급자를 감싸서** 같은 종목을 두 번 부르지 않게 한다:
// 카드 5장이 삼성전자면 조회는 1회, 카드 100장이어도 종목 수만큼만 나간다.
//
// 구간이 카드마다 다른 것(게시일이 제각각)은 **덮는 범위를 넓혀 가며** 해결한다.
// 이미 받아 둔 구간이 요청을 덮으면 잘라서 주고, 모자라면 합집합을 다시 받아 채운다.
//
// 수명은 **배치 1회**다. 오래 들고 있으면 장중에 갱신되는 당일 종가를 놓치므로,
// 배치가 시작할 때 만들고 끝나면 버린다.

interface CachedRange {
  from: string;
  to: string;
  quotes: DailyQuote[];
}

function memoizeProvider(provider: MarketDataProvider): MarketDataProvider {
  const ranges = new Map<string, CachedRange>();
  const statuses = new Map<string, SecurityStatus>();

  return {
    sourceId: provider.sourceId,

    async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
      const cached = ranges.get(ticker);
      // 날짜가 YYYY-MM-DD라 문자열 비교가 곧 시간 비교다
      const covered = cached !== undefined && cached.from <= from && cached.to >= to;
      if (!covered) {
        const nextFrom = cached && cached.from < from ? cached.from : from;
        const nextTo = cached && cached.to > to ? cached.to : to;
        const quotes = await provider.getDailyQuotes(ticker, nextFrom, nextTo);
        ranges.set(ticker, { from: nextFrom, to: nextTo, quotes });
      }
      const hit = ranges.get(ticker)!;
      return hit.quotes.filter((q) => q.date >= from && q.date <= to);
    },

    async getSecurityStatus(ticker: string, asOf: string): Promise<SecurityStatus> {
      const key = `${ticker}@${asOf}`;
      const hit = statuses.get(key);
      if (hit) return hit;
      const status = await provider.getSecurityStatus(ticker, asOf);
      statuses.set(key, status);
      return status;
    },

    // 현재가는 감싸지 않는다 — 매 순간 바뀌는 값이라 캐시가 오히려 거짓말이 된다.
    // (화면·결제 관문용 60초 캐시는 server/priceCache가 따로 맡는다)
    getCurrentPrice: provider.getCurrentPrice
      ? (ticker: string): Promise<number> => provider.getCurrentPrice!(ticker)
      : undefined,

    listInstruments: provider.listInstruments
      ? (): Promise<InstrumentListing[]> => provider.listInstruments!()
      : undefined,
  };
}

/** 레지스트리 전체를 감싼다 — 배치 시작 시 한 번 만들고 끝나면 버린다 */
export function memoizeRegistry(registry: ProviderRegistry): ProviderRegistry {
  const out: ProviderRegistry = {};
  for (const [assetClass, provider] of Object.entries(registry)) {
    if (provider) out[assetClass as AssetClass] = memoizeProvider(provider);
  }
  return out;
}
