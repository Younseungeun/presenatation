import { describe, expect, it } from 'vitest';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  crossCheckJudgment,
  maxCloseDeviation,
  resolveCrossCheckMode,
  type CrossCheckInput,
} from '../crossCheck';
import { judge, type PredictionInput } from '../judgment';
import type { DailyQuote } from '../marketData';
import { runJudgment, type JudgeableCard } from '../judgmentPipeline';

const NOW = new Date('2026-07-12T05:00:00Z');

const prediction: PredictionInput = {
  direction: 'UP',
  targetType: 'TARGET_PRICE',
  targetValue: 120000,
  basePrice: 100000,
};

function bar(date: string, close: number): DailyQuote {
  return { date, open: close, high: close, low: close, close, volume: 1000 };
}

function input(primary: DailyQuote[], secondary: DailyQuote[]): CrossCheckInput {
  return {
    prediction,
    primaryResult: judge(prediction, {
      status: 'TRADED',
      maxCloseSincePublish: Math.max(...primary.map((q) => q.close)),
      minCloseSincePublish: Math.min(...primary.map((q) => q.close)),
      priceAtDeadline: primary[primary.length - 1].close,
    }),
    primaryQuotes: primary,
    secondaryQuotes: secondary,
    secondarySourceId: 'second',
    deadlineDate: '2026-07-10',
  };
}

describe('crossCheckJudgment — 값이 아니라 결론을 대조한다', () => {
  it('두 소스의 값이 달라도 판정이 같으면 합의다', () => {
    // 목표선(120,000)에서 멀리 떨어진 자리의 1% 차이는 아무것도 바꾸지 않는다
    const r = crossCheckJudgment(
      input(
        [bar('2026-07-09', 105_000), bar('2026-07-10', 106_000)],
        [bar('2026-07-09', 105_900), bar('2026-07-10', 107_060)],
      ),
    );
    expect(r.status).toBe('AGREED');
    expect(r.primaryOutcome).toBe('MISS');
    expect(r.secondaryOutcome).toBe('MISS');
    // 합의해도 괴리는 기록한다 — 소스가 서서히 어긋나는 것은 이 값으로만 보인다
    expect(r.maxCloseDeviation).toBeCloseTo(0.01, 3);
  });

  it('목표선을 사이에 두고 갈리면 불일치다 — 문턱을 고를 필요가 없다', () => {
    // 값 차이는 0.4%로 위 사례보다 **작지만**, 목표선 위아래로 갈려 판정이 뒤집힌다.
    // 가격 허용 오차 방식이었다면 이쪽을 통과시키고 위쪽을 사고로 신고했을 것이다
    const r = crossCheckJudgment(
      input([bar('2026-07-10', 120_100)], [bar('2026-07-10', 119_600)]),
    );
    expect(r.status).toBe('DISAGREED');
    expect(r.primaryOutcome).toBe('HIT');
    expect(r.secondaryOutcome).toBe('MISS');
    expect(r.maxCloseDeviation!).toBeLessThan(0.005);
  });

  it('구간 한가운데의 튀는 값이 만든 오적중을 잡는다 (시한 종가만 봤다면 놓친다)', () => {
    // 시한 종가는 두 소스가 똑같다 — 대조 대상이 "판정 시점 기준가 1개"였다면 통과한다
    const primary = [bar('2026-07-08', 121_000), bar('2026-07-10', 104_000)];
    const secondary = [bar('2026-07-08', 104_500), bar('2026-07-10', 104_000)];
    const r = crossCheckJudgment(input(primary, secondary));
    expect(r.status).toBe('DISAGREED');
    expect(r.primaryOutcome).toBe('HIT');
    expect(r.secondaryOutcome).toBe('MISS');
  });

  it('두 번째 소스가 답하지 못한 것은 반대 의견이 아니다', () => {
    const r = crossCheckJudgment(input([bar('2026-07-10', 104_000)], []));
    expect(r.status).toBe('NO_DATA');
  });

  it('겹치는 날짜가 없으면 괴리를 지어내지 않는다', () => {
    expect(maxCloseDeviation([bar('2026-07-10', 100)], [bar('2026-07-09', 500)])).toBeNull();
  });
});

describe('resolveCrossCheckMode — 검증 안 된 소스에 정산을 멈출 권한을 주지 않는다', () => {
  it('값이 없거나 이상하면 shadow로 떨어진다', () => {
    expect(resolveCrossCheckMode({})).toBe('shadow');
    expect(resolveCrossCheckMode({ CROSS_CHECK_MODE: 'yes-please' })).toBe('shadow');
  });

  it('명시한 값만 그대로 쓴다', () => {
    expect(resolveCrossCheckMode({ CROSS_CHECK_MODE: 'off' })).toBe('off');
    expect(resolveCrossCheckMode({ CROSS_CHECK_MODE: 'ENFORCE' })).toBe('enforce');
  });
});

// ── 파이프라인 배선 ────────────────────────────────────────────────
const card: JudgeableCard = {
  assetClass: 'KR_EQUITY',
  baseMode: 'FIXED_AT_PUBLISH',
  ticker: '005930',
  direction: 'UP',
  targetType: 'TARGET_PRICE',
  targetValue: 120000,
  basePrice: 100000,
  publishedAt: new Date('2026-06-01T00:00:00Z'),
  deadline: new Date('2026-07-10T06:00:00Z'),
};

function providerAt(close: number, ticker = '005930') {
  const p = new FixtureMarketDataProvider();
  p.setQuotes(ticker, [bar('2026-07-10', close)]);
  return p;
}

describe('runJudgment × 교차검증', () => {
  it('shadow 모드는 결론이 갈려도 판정을 막지 않고 기록만 남긴다', async () => {
    const { result, audit } = await runJudgment(
      card,
      providerAt(121_000),
      NOW,
      providerAt(119_000),
      'shadow',
    );
    expect(result.outcome).toBe('HIT'); // 주 소스대로 나간다
    expect(audit.crossCheck?.status).toBe('DISAGREED');
  });

  it('enforce 모드는 판정하지 않고 던진다', async () => {
    await expect(
      runJudgment(card, providerAt(121_000), NOW, providerAt(119_000), 'enforce'),
    ).rejects.toMatchObject({ name: 'JudgmentDisagreementError' });
  });

  it('두 번째 소스가 없어도 판정은 나가고, 없었다는 사실이 감사에 남는다', async () => {
    const { result, audit } = await runJudgment(card, providerAt(121_000), NOW, undefined, 'enforce');
    expect(result.outcome).toBe('HIT');
    expect(audit.crossCheck?.status).toBe('NO_SECONDARY');
  });

  it('두 번째 소스의 장애는 삼킨다 — 보조가 죽었다고 본체가 멈추면 안 된다', async () => {
    const secondary = providerAt(121_000);
    secondary.getDailyQuotes = async () => {
      throw new Error('빗썸 HTTP 503');
    };
    const { result, audit } = await runJudgment(
      card,
      providerAt(121_000),
      NOW,
      secondary,
      'enforce',
    );
    expect(result.outcome).toBe('HIT');
    expect(audit.crossCheck?.status).toBe('SOURCE_ERROR');
  });

  it('off 모드에서는 두 번째 소스를 아예 부르지 않는다', async () => {
    const secondary = providerAt(119_000);
    let called = 0;
    const orig = secondary.getDailyQuotes.bind(secondary);
    secondary.getDailyQuotes = async (t: string, f: string, to: string) => {
      called += 1;
      return orig(t, f, to);
    };
    const { audit } = await runJudgment(card, providerAt(121_000), NOW, secondary, 'off');
    expect(called).toBe(0);
    expect(audit.crossCheck).toBeUndefined();
  });
});
