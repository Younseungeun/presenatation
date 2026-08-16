import {
  resolveProvider,
  toMarketDateString,
  type ProviderRegistry,
} from '@/domain/marketData';
import type { AssetClass } from '@/domain/constants';
import { estimateDailySigma, MAX_RETURN_SAMPLES } from '@/domain/stability';

// 게시 시점 실현 변동성 측정 — **p₀·크기 하한·안정성 별점 셋의 원천 데이터.**
// 추정 방식은 domain/stability.estimateDailySigma 한 곳에 있다 (종가 σ + Parkinson).
//
// 게시 순간에 한 번 재서 카드에 고정한다(sigmaDaily). 표시 때마다 다시 재면
//  · 카드 목록 한 번에 종목 수만큼 시세 호출이 나가고 (KIS 초당 1회 제한과 정면 충돌)
//  · 같은 카드의 별이 날마다 바뀌어 "게시 시점의 사양" 원칙이 깨진다.
//
// 실패는 null로 삼킨다 — 별점은 부가 정보라 시세 조회 장애가 게시를 막으면 안 된다.
// (기준가 조회 fetchBasePrice는 반대로 실패가 게시를 막는다 — 판정의 전제라서다.)

/** 표본 확보용 달력 구간 — 주말·휴장 감안 넉넉히 (거래일/달력일 ≈ 0.68) */
const CALENDAR_LOOKBACK_DAYS = Math.ceil((MAX_RETURN_SAMPLES + 1) / 0.6);

/**
 * σ를 못 낸 이유 — **둘을 가르지 않으면 게시를 막을 수 없다.**
 *
 * 42차 검토에서 σ 미측정 종목의 게시를 막기로 했는데, 그때 반드시 필요한 구분이다:
 *  · `INSUFFICIENT_SAMPLES` — 일봉은 왔는데 σ를 낼 수 없다. **종목의 성질**이라
 *    다시 불러도 같은 답이고, 20거래일이 쌓여야 바뀐다 → **게시를 막는다**
 *  · `UNAVAILABLE` — 일봉 자체가 안 왔다. **일시적**이라 다음 호출이면 풀린다
 *    → 종전대로 게시를 진행하고 치유 배치가 나중에 메운다
 *
 * 가르지 않고 막으면 **KIS 장애 한 번이 전 종목의 게시를 멈춘다.** 반대로 가르지 않고
 * 놔두면 신규 상장 종목에서 무실력 파밍이 열린다(domain/scoring.ts UNMEASURED_SIGMA).
 *
 * `INSUFFICIENT_SAMPLES`에는 표본 부족만이 아니라 **거래가 말라 σ를 낼 수 없는 종목**도
 * 들어간다(estimateDailySigma의 MIN_MOVING_RATIO). 둘 다 "이 종목은 지금 잴 수 없다"라
 * 처분이 같고, 처분이 같은 것을 나누면 부르는 쪽만 복잡해진다.
 *
 * 세 번째 갈래 `NO_QUOTES`(일봉이 0개)는 **여기서 판단하지 않는다.** 같은 빈 응답이
 * 상장 당일 종목일 수도, 죽은 공급자일 수도 있어서다. 가르는 데 필요한 정보는
 * 시세가 아니라 **우리의 관측 이력**이라, 그것을 아는 자리(instrumentSigma)에서 정한다.
 */
export type SigmaFailure = 'INSUFFICIENT_SAMPLES' | 'NO_QUOTES' | 'UNAVAILABLE';
export type SigmaResult = { sigma: number } | { sigma: null; reason: SigmaFailure };

/**
 * 종목의 최근 실현 변동성 (하루 로그수익률 표준편차)과, 못 냈으면 그 이유.
 */
export async function fetchRealizedSigmaResult(
  registry: ProviderRegistry,
  assetClass: AssetClass,
  ticker: string,
  now = new Date(),
): Promise<SigmaResult> {
  let quotes;
  try {
    const provider = resolveProvider(registry, assetClass);
    const to = toMarketDateString(now, assetClass);
    const from = toMarketDateString(
      new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * 86_400_000),
      assetClass,
    );
    quotes = await provider.getDailyQuotes(ticker, from, to);
  } catch {
    return { sigma: null, reason: 'UNAVAILABLE' };
  }
  // 빈 응답은 그대로 "빈 응답"이라고만 말한다 — 이것이 신규 상장인지 죽은 공급자인지는
  // 시세로 알 수 없고, 부르는 쪽이 관측 이력을 보고 정한다
  if (quotes.length === 0) return { sigma: null, reason: 'NO_QUOTES' };

  const sigma = estimateDailySigma(
    {
      closes: quotes.map((q) => q.close),
      highs: quotes.map((q) => q.high),
      lows: quotes.map((q) => q.low),
      volumes: quotes.map((q) => q.volume),
    },
    assetClass,
  );
  return sigma === null ? { sigma: null, reason: 'INSUFFICIENT_SAMPLES' } : { sigma };
}

/** 이유가 필요 없는 자리용 (별점 표시·백필). 못 냈으면 null. */
export async function fetchRealizedSigma(
  registry: ProviderRegistry,
  assetClass: AssetClass,
  ticker: string,
  now = new Date(),
): Promise<number | null> {
  return (await fetchRealizedSigmaResult(registry, assetClass, ticker, now)).sigma;
}
