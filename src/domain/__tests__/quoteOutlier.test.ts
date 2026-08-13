import { describe, expect, it } from 'vitest';
import { IMPLAUSIBLE_DAILY_MOVE, JudgmentDeferredError, runJudgment } from '../judgmentPipeline';
import type { MarketDataProvider, DailyQuote } from '../marketData';

// **시세 한 줄이 튀면 카드가 오적중된다.**
//
// 판정은 게시일~시한의 종가 **극값**이 목표를 넘었는지로 정한다. 공급자가 하루치를
// 잘못 주면(0, 자릿수 오류, 통화 혼동) 그 한 줄로 적중이 되고 구매자는 환불을 못 받는다.
// 권리 사건 앵커(domain/corporateAction)는 **과거 종가가 소급해 바뀌는 것**을 잡는
// 장치라 하루짜리 튀는 값은 거르지 못한다.
//
// 문턱 근거는 실일봉 2019~2023 캘리브레이션이다 (scripts/calibrateQuoteOutlier.ts):
// 국내 최대 6.9σ(+19.4%) · 미국 7.1σ(+24.4%) · 코인 16.4σ(+68.6%).
// 자산군마다 진짜 급변의 크기가 달라 σ 배수 하나로는 덮이지 않았다.

const PUBLISHED = new Date('2026-09-01T00:00:00Z');
const DEADLINE = new Date('2026-09-30T06:00:00Z');
const NOW = new Date('2026-10-01T00:00:00Z');

function provider(quotes: DailyQuote[]): MarketDataProvider {
  return {
    source: 'test',
    getDailyQuotes: async () => quotes,
    getSecurityStatus: async () => ({ delisted: false, halted: false }),
  } as unknown as MarketDataProvider;
}

function bar(date: string, close: number): DailyQuote {
  return { date, open: close, high: close, low: close, close, volume: 1 };
}

/** 기준가 10,000 · 상승 +10% (목표 11,000) 카드 */
function card(assetClass: 'KR_EQUITY' | 'US_EQUITY' | 'CRYPTO', ticker: string) {
  return {
    assetClass,
    ticker,
    direction: 'UP' as const,
    targetType: 'RETURN_PCT' as const,
    targetValue: 10,
    baseMode: 'FIXED_AT_PUBLISH' as const,
    basePrice: 10_000,
    publishedAt: PUBLISHED,
    deadline: DEADLINE,
  };
}

describe('불가능한 일봉은 판정하지 않고 이월한다', () => {
  it('정상 시세는 그대로 판정된다', async () => {
    const p = provider([bar('2026-09-10', 10_500), bar('2026-09-20', 11_200)]);
    const r = await runJudgment(card('KR_EQUITY', '005930'), p, NOW);
    expect(r.result.outcome).toBe('HIT');
  });

  it('국내주식: 가격제한폭(±30%)을 넘는 종가는 데이터 사고로 본다', async () => {
    // 10,000 → 14,000 (+40%). 거래소 규칙상 불가능하다
    const p = provider([bar('2026-09-10', 14_000)]);
    await expect(runJudgment(card('KR_EQUITY', '005930'), p, NOW)).rejects.toThrow(
      JudgmentDeferredError,
    );
  });

  it('국내주식: 제한폭 안의 큰 변동(+19%)은 통과한다 — 실측 최대가 +19.4%였다', async () => {
    const p = provider([bar('2026-09-10', 11_900)]);
    const r = await runJudgment(card('KR_EQUITY', '005930'), p, NOW);
    expect(r.result.outcome).toBe('HIT'); // 목표 11,000을 넘었다
  });

  it('미국주식: 실측 최대(+24.4%)는 통과하고 자릿수 오류는 걸린다', async () => {
    const ok = provider([bar('2026-09-10', 12_440)]);
    expect((await runJudgment(card('US_EQUITY', 'NVDA'), ok, NOW)).result.outcome).toBe('HIT');

    const tenfold = provider([bar('2026-09-10', 100_000)]); // ×10 사고
    await expect(runJudgment(card('US_EQUITY', 'NVDA'), tenfold, NOW)).rejects.toThrow(
      JudgmentDeferredError,
    );
  });

  it('코인: 실측 최대(+68.6%)는 통과한다 — 코인은 진짜로 그만큼 간다', async () => {
    const p = provider([bar('2026-09-10', 16_860)]);
    const r = await runJudgment(card('CRYPTO', 'KRW-XRP'), p, NOW);
    expect(r.result.outcome).toBe('HIT');
  });

  it('통화 혼동 같은 자릿수 사고는 자산군과 무관하게 걸린다', async () => {
    const p = provider([bar('2026-09-10', 13_000_000)]); // ×1,300
    await expect(runJudgment(card('CRYPTO', 'KRW-BTC'), p, NOW)).rejects.toThrow(
      JudgmentDeferredError,
    );
  });

  it('종가 0은 즉시 걸린다 — 나눗셈 이전에 막아야 한다', async () => {
    const p = provider([bar('2026-09-10', 0)]);
    await expect(runJudgment(card('KR_EQUITY', '005930'), p, NOW)).rejects.toThrow(
      JudgmentDeferredError,
    );
  });

  it('구간 **중간**에서 튀어도 잡는다 — 극값이 판정을 정하므로 위치와 무관하다', async () => {
    const p = provider([
      bar('2026-09-05', 10_100),
      bar('2026-09-10', 50_000), // 튄 값
      bar('2026-09-20', 10_200),
    ]);
    await expect(runJudgment(card('KR_EQUITY', '005930'), p, NOW)).rejects.toThrow(
      JudgmentDeferredError,
    );
  });

  it('문턱은 자산군별로 다르다 — 하나로 덮이지 않는다는 것이 측정 결과다', () => {
    expect(IMPLAUSIBLE_DAILY_MOVE.KR_EQUITY).toBe(0.3); // 거래소 가격제한폭
    expect(IMPLAUSIBLE_DAILY_MOVE.US_EQUITY).toBeGreaterThan(IMPLAUSIBLE_DAILY_MOVE.KR_EQUITY);
    expect(IMPLAUSIBLE_DAILY_MOVE.CRYPTO).toBeGreaterThan(IMPLAUSIBLE_DAILY_MOVE.US_EQUITY);
  });
});
