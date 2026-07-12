import { describe, expect, it } from 'vitest';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { runJudgmentFromRegistry, type JudgeableCard } from '../judgmentPipeline';
import { resolveProvider, toMarketDateString, type ProviderRegistry } from '../marketData';

describe('toMarketDateString — 자산군별 거래일 환산', () => {
  // KST 2026-07-11 새벽 3시 = ET 2026-07-10 오후 2시 (미국 장중)
  const kstDawn = new Date('2026-07-10T18:00:00Z');

  it('같은 순간이 자산군에 따라 다른 거래일이 된다', () => {
    expect(toMarketDateString(kstDawn, 'KR_EQUITY')).toBe('2026-07-11');
    expect(toMarketDateString(kstDawn, 'US_EQUITY')).toBe('2026-07-10');
    expect(toMarketDateString(kstDawn, 'CRYPTO')).toBe('2026-07-11'); // 업비트 KST 일봉 기준
  });
});

describe('resolveProvider — 자산군별 공급자 라우팅', () => {
  it('등록된 자산군은 해당 공급자를 반환', () => {
    const fixture = new FixtureMarketDataProvider();
    const registry: ProviderRegistry = { CRYPTO: fixture };
    expect(resolveProvider(registry, 'CRYPTO')).toBe(fixture);
  });

  it('미등록 자산군은 에러 — 조용한 오판정 대신 배치 실패', () => {
    expect(() => resolveProvider({}, 'US_EQUITY')).toThrow(/US_EQUITY/);
  });
});

describe('runJudgmentFromRegistry — 코인 카드 종단 판정', () => {
  const NOW = new Date('2026-07-12T00:00:00Z');

  const btcCard: JudgeableCard = {
    assetClass: 'CRYPTO',
    baseMode: 'FIXED_AT_PUBLISH',
    ticker: 'KRW-BTC',
    direction: 'DOWN',
    targetType: 'RETURN_PCT',
    targetValue: 15, // -15% 이상 하락 예측
    basePrice: 100_000_000,
    publishedAt: new Date('2026-06-01T00:00:00Z'),
    deadline: new Date('2026-07-11T00:00:00Z'), // 토요일 — 크립토는 24/7이라 그대로 판정
  };

  it('주말 시한도 크립토는 당일 캔들로 판정된다', async () => {
    const provider = new FixtureMarketDataProvider().setQuotes('KRW-BTC', [
      {
        date: '2026-07-10',
        open: 90_000_000,
        high: 91_000_000,
        low: 84_000_000,
        close: 86_000_000,
        volume: 1200,
      },
      {
        date: '2026-07-11',
        open: 86_000_000,
        high: 87_000_000,
        low: 83_000_000,
        close: 84_000_000, // -16% → 하락 예측 적중
        volume: 900,
      },
    ]);
    const { result, audit } = await runJudgmentFromRegistry(
      btcCard,
      { CRYPTO: provider },
      NOW,
    );
    expect(result.outcome).toBe('HIT');
    expect(result.settledPrice).toBe(84_000_000);
    expect(audit.dataSource).toBe('fixture');
  });

  it('공급자 미등록 자산군 카드는 판정 시도 자체가 실패', async () => {
    await expect(runJudgmentFromRegistry(btcCard, {}, NOW)).rejects.toThrow(/CRYPTO/);
  });
});
