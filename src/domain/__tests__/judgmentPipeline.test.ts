import { describe, expect, it } from 'vitest';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { runJudgment, type JudgeableCard } from '../judgmentPipeline';
import { settle } from '../settlement';

const NOW = new Date('2026-07-12T05:00:00Z'); // KST 2026-07-12 14:00 (배치 시각)

const baseCard: JudgeableCard = {
  assetClass: 'KR_EQUITY',
  baseMode: 'FIXED_AT_PUBLISH',
  ticker: '005930',
  direction: 'UP',
  targetType: 'TARGET_PRICE',
  targetValue: 120000,
  basePrice: 100000,
  publishedAt: new Date('2026-06-01T00:00:00Z'),
  deadline: new Date('2026-07-10T06:00:00Z'), // KST 2026-07-10 15:00
};

function providerWithQuotes(highs: Array<[string, number]>) {
  const p = new FixtureMarketDataProvider();
  p.setQuotes(
    '005930',
    highs.map(([date, high]) => ({
      date,
      open: 100000,
      high,
      low: 95000,
      close: high - 1000,
      volume: 10000,
    })),
  );
  return p;
}

describe('runJudgment', () => {
  it('시한 미도래 카드는 판정하지 않고 이월', async () => {
    const early = new Date('2026-07-01T00:00:00Z');
    await expect(runJudgment(baseCard, providerWithQuotes([]), early)).rejects.toMatchObject({
      name: 'JudgmentDeferredError',
      reason: 'DEADLINE_NOT_REACHED',
    });
  });

  it('정상 종목인데 시세 결측 → 소스 지연으로 보고 이월 (오판정 방지)', async () => {
    await expect(runJudgment(baseCard, providerWithQuotes([]), NOW)).rejects.toMatchObject({
      name: 'JudgmentDeferredError',
      reason: 'DATA_NOT_AVAILABLE',
    });
  });

  it('목표가 도달 → HIT + 감사 스냅샷에 원천 데이터·소스 기록', async () => {
    const provider = providerWithQuotes([
      ['2026-06-15', 115000],
      ['2026-07-01', 121000],
      ['2026-07-10', 118000],
    ]);
    const { result, audit } = await runJudgment(baseCard, provider, NOW);
    expect(result.outcome).toBe('HIT');
    expect(audit.dataSource).toBe('fixture');
    expect(audit.quotes).toHaveLength(3);
    expect(audit.securityStatus).toEqual({ delisted: false, halted: false });
  });

  it('거래정지 종목 → UNDECIDABLE, 정산은 전액 환불', async () => {
    const provider = new FixtureMarketDataProvider().setStatus('005930', {
      delisted: false,
      halted: true,
    });
    const { result } = await runJudgment(baseCard, provider, NOW);
    expect(result).toMatchObject({ outcome: 'UNDECIDABLE', undecidableReason: 'TRADING_HALT' });

    // 판정 → 정산 연결 확인
    const settlement = settle({
      amountKrw: 30000,
      feeRateBp: 2000,
      prepaymentRatio: 0,
      outcome: result.outcome,
    });
    expect(settlement.buyerRefundKrw).toBe(30000);
    expect(settlement.refundType).toBe('FULL_REFUND');
  });

  it('기준가 소급 확정(KR 당일 카드): 게시일 직전 종가 기준으로 판정', async () => {
    // 월요일(07-13) 개장 전 게시, 당일 종가 +2% 예측. 직전 거래일 = 금요일(07-10)
    const card: JudgeableCard = {
      assetClass: 'KR_EQUITY',
      baseMode: 'PREV_CLOSE_AT_JUDGMENT',
      ticker: '005930',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 2,
      basePrice: null, // 게시 시점엔 미확정
      publishedAt: new Date('2026-07-12T22:00:00Z'), // KST 월 07:00
      deadline: new Date('2026-07-13T06:30:00Z'), // KST 월 15:30
    };
    const provider = new FixtureMarketDataProvider().setQuotes('005930', [
      { date: '2026-07-10', open: 100, high: 101, low: 99, close: 100_000, volume: 1 }, // 금요일 종가 = 기준가
      { date: '2026-07-13', open: 100_500, high: 103_000, low: 100_000, close: 102_500, volume: 1 }, // +2.5%
    ]);
    const judgeTime = new Date('2026-07-14T04:30:00Z'); // 화 13:30 KST 배치
    const { result, resolvedBasePrice } = await runJudgment(card, provider, judgeTime);
    expect(resolvedBasePrice).toBe(100_000);
    expect(result.outcome).toBe('HIT');
    expect(result.settledPrice).toBe(102_500);
  });

  it('기준가 소급 확정: 직전 종가 데이터가 아직 없으면 이월', async () => {
    const card: JudgeableCard = {
      assetClass: 'KR_EQUITY',
      baseMode: 'PREV_CLOSE_AT_JUDGMENT',
      ticker: '005930',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 2,
      basePrice: null,
      publishedAt: new Date('2026-07-12T22:00:00Z'),
      deadline: new Date('2026-07-13T06:30:00Z'),
    };
    // 게시일 당일 캔들만 있고 직전 종가가 없음 (소스 지연)
    const provider = new FixtureMarketDataProvider().setQuotes('005930', [
      { date: '2026-07-13', open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]);
    await expect(
      runJudgment(card, provider, new Date('2026-07-14T04:30:00Z')),
    ).rejects.toMatchObject({ name: 'JudgmentDeferredError', reason: 'DATA_NOT_AVAILABLE' });
  });

  it('시한 이후 시세는 조회 범위에서 제외되어 판정에 영향 없음', async () => {
    const provider = providerWithQuotes([
      ['2026-07-01', 110000],
      ['2026-07-11', 130000], // 시한 다음 날 급등 — 반영되면 안 됨
    ]);
    const { result } = await runJudgment(baseCard, provider, NOW);
    expect(result.outcome).toBe('MISS');
  });
});
