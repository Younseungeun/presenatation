import {
  resolveProvider,
  toMarketDateString,
  type ProviderRegistry,
} from '@/domain/marketData';
import type { AssetClass } from '@/domain/constants';
import { MAX_RETURN_SAMPLES, realizedDailySigma } from '@/domain/stability';

// 게시 시점 실현 변동성 측정 — 안정성 별점(domain/stability.ts)의 원천 데이터.
//
// 게시 순간에 한 번 재서 카드에 고정한다(sigmaDaily). 표시 때마다 다시 재면
//  · 카드 목록 한 번에 종목 수만큼 시세 호출이 나가고 (KIS 초당 1회 제한과 정면 충돌)
//  · 같은 카드의 별이 날마다 바뀌어 "게시 시점의 사양" 원칙이 깨진다.
//
// 실패는 null로 삼킨다 — 별점은 부가 정보라 시세 조회 장애가 게시를 막으면 안 된다.
// (기준가 조회 fetchBasePrice는 반대로 실패가 게시를 막는다 — 판정의 전제라서다.)

/** 60거래일 표본 확보용 달력 구간 — 주말·휴장 감안 넉넉히 (거래일/달력일 ≈ 0.68) */
const CALENDAR_LOOKBACK_DAYS = Math.ceil((MAX_RETURN_SAMPLES + 1) / 0.6);

/**
 * 종목의 최근 실현 변동성 (하루 로그수익률 표준편차).
 * 표본 부족(신규 상장)·공급자 미등록·조회 실패 전부 null.
 */
export async function fetchRealizedSigma(
  registry: ProviderRegistry,
  assetClass: AssetClass,
  ticker: string,
  now = new Date(),
): Promise<number | null> {
  try {
    const provider = resolveProvider(registry, assetClass);
    const to = toMarketDateString(now, assetClass);
    const from = toMarketDateString(
      new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * 86_400_000),
      assetClass,
    );
    const quotes = await provider.getDailyQuotes(ticker, from, to);
    return realizedDailySigma(quotes.map((q) => q.close));
  } catch {
    return null;
  }
}
