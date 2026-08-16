import { describe, expect, it } from 'vitest';
import type { DailyQuote } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { fetchRealizedSigmaResult } from '../realizedVolatility';

// **σ를 못 낸 이유를 가른다** — 이 구분 하나에 게시 관문이 걸려 있다.
//
// 42차 확정: 표본이 모자란 종목(신규 상장)은 게시를 막고, 시세를 못 받은 경우
// (일시 장애)는 종전대로 게시를 진행한다. 둘을 `null` 하나로 뭉개면 선택지가 둘뿐인데
// 어느 쪽도 옳지 않다:
//   · 전부 막는다  → **KIS 장애 한 번이 전 종목의 게시를 멈춘다**
//   · 전부 놔둔다  → 신규 상장 종목에서 무실력 파밍이 열린다(카드당 +11 ~ +67,
//                    scripts/probeNewListingSigma.ts)
//
// 그래서 이 파일이 지키는 것은 값이 아니라 **이유**다.

const TICKER = 'KRW-TEST';
// 픽스처 일봉이 조회 구간(now 기준 과거 ~202일) 안에 들어오도록 시각을 고정한다
const NOW = new Date('2026-03-05T00:00:00Z');

function quotes(n: number): DailyQuote[] {
  // 날마다 조금씩 다른 종가 — 값이 같으면 "거래가 없다"로 걸려 표본 수와 무관하게 실패한다
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + (i % 7) - 3;
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    return { date, open: close, high: close + 1, low: close - 1, close, volume: 1_000 + i };
  });
}

const registryWith = (bars: DailyQuote[]) => ({
  CRYPTO: new FixtureMarketDataProvider().setQuotes(TICKER, bars),
});

describe('σ 결측의 이유를 가른다', () => {
  it('일봉이 0개면 **판단을 미룬다** — 신규 상장인지 죽은 공급자인지 시세로는 모른다', async () => {
    const r = await fetchRealizedSigmaResult(registryWith([]), 'CRYPTO', TICKER, NOW);
    expect(r.sigma).toBeNull();
    // 가르는 데 필요한 것은 시세가 아니라 관측 이력이라, 그것을 아는 자리에서 정한다
    expect(r.sigma === null && r.reason).toBe('NO_QUOTES');
  });

  it('공급자가 던지면 **일시 장애**로 본다', async () => {
    const broken = {
      CRYPTO: new (class extends FixtureMarketDataProvider {
        async getDailyQuotes(): Promise<DailyQuote[]> {
          throw new Error('업스트림 500');
        }
      })(),
    };
    const r = await fetchRealizedSigmaResult(broken, 'CRYPTO', TICKER, NOW);
    expect(r.sigma === null && r.reason).toBe('UNAVAILABLE');
  });

  it('일봉은 왔는데 표본이 모자라면 **표본 부족** — 이쪽만 게시를 막는다', async () => {
    const r = await fetchRealizedSigmaResult(registryWith(quotes(10)), 'CRYPTO', TICKER, NOW);
    expect(r.sigma).toBeNull();
    expect(r.sigma === null && r.reason).toBe('INSUFFICIENT_SAMPLES');
  });

  it('표본이 충분하면 값이 나온다 — 관문이 통과 경로를 실제로 갖고 있다', async () => {
    const r = await fetchRealizedSigmaResult(registryWith(quotes(60)), 'CRYPTO', TICKER, NOW);
    expect(r.sigma).toBeGreaterThan(0);
  });

  it('종가가 며칠씩 같은 종목도 **표본 부족**으로 센다 — 거래가 없는 것은 조용한 것이 아니다', async () => {
    const flat = quotes(60).map((q) => ({ ...q, close: 100, high: 100, low: 100 }));
    const r = await fetchRealizedSigmaResult(registryWith(flat), 'CRYPTO', TICKER, NOW);
    expect(r.sigma === null && r.reason).toBe('INSUFFICIENT_SAMPLES');
  });
});
