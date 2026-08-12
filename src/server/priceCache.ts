import type { AssetClass } from '@/domain/constants';
import { toMarketDateString } from '@/domain/marketData';
import { createDefaultRegistry } from '@/infra/marketData/registry';

// 화면·게이트용 시세 캐시 — **판정용 시세가 아니다.**
// 판정은 시한 시점 확정 시세로만 이뤄지고, 이 값은 "지금 어디쯤"의 답일 뿐이다.
//
// 60초 캐시: 같은 화면 안에서는 종목당 한 번, 결제 관문에서도 호출 폭주가 없다.
// 실시간을 안 주는 소스(주식)는 최근 종가로 대신하고, 장애·미지원은 null —
// 쓰는 쪽이 "없으면 없는 대로" 동작해야 한다 (화면은 시간 전용 막대로,
// 결제 관문은 DB 상태만으로 내려간다).

const PRICE_TTL_MS = 60_000;
const priceCache = new Map<string, { at: number; price: number | null }>();

// 테스트 대체 시세 — 단위 테스트가 실서비스 시세에 좌우되면 안 된다.
// (픽스처 카드의 기준가 7천만원과 진짜 비트코인 시세가 충돌해 결제 게이트가
// 무작위로 발동하는 사고가 실제로 났다.) vitest에서는 기본이 "시세 없음"이고,
// 게이트 동작 자체를 시험하고 싶은 테스트만 setPriceForTests로 값을 꽂는다.
// 반환형에 Promise를 허용한다 — 테스트가 "시세를 조회하는 그 순간"에 다른 일(예: 배치가
// 리포트를 닫는 것)을 끼워 넣어 경합을 **결정적으로** 재현할 수 있어야 하기 때문이다.
type TestPriceFn = (assetClass: string, ticker: string) => number | null | Promise<number | null>;
let testPriceFn: TestPriceFn | null = null;

export function setPriceForTests(fn: TestPriceFn | null): void {
  testPriceFn = fn;
}

export async function fetchCachedPrice(
  assetClass: string,
  ticker: string,
): Promise<number | null> {
  if (process.env.VITEST) return testPriceFn ? testPriceFn(assetClass, ticker) : null;
  const key = `${assetClass}:${ticker}`;
  const hit = priceCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.price;

  // 실시간 현재가 → 실패하면 최근 일봉 종가로 **폴백**한다.
  // 판매 중단 검사가 이 값 하나에 의존하므로, 실시간 API가 잠깐 흔들렸다고
  // 가격 방어가 통째로 꺼지면 안 된다. 전일 종가는 낡았지만 "없음"보다 낫고,
  // 중단선(광고 폭의 절반)은 넓은 띠라 하루치 오차로 결론이 잘 바뀌지 않는다.
  const provider = createDefaultRegistry()[assetClass as AssetClass];
  let price: number | null = null;
  if (provider) {
    if (provider.getCurrentPrice) {
      try {
        price = await provider.getCurrentPrice(ticker);
      } catch {
        price = null; // 아래 일봉 폴백으로
      }
    }
    if (price === null || !Number.isFinite(price) || price <= 0) {
      try {
        const to = toMarketDateString(new Date(), assetClass as AssetClass);
        const from = toMarketDateString(
          new Date(Date.now() - 10 * 86_400_000),
          assetClass as AssetClass,
        );
        const quotes = await provider.getDailyQuotes(ticker, from, to);
        price = quotes.length > 0 ? quotes[quotes.length - 1].close : null;
      } catch {
        price = null;
      }
    }
  }

  priceCache.set(key, { at: now, price });
  return price;
}
