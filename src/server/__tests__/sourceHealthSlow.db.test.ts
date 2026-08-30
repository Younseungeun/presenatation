import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { noteQuoteRefreshHealth, reportQuoteDelay, readSourceHealth } from '../sourceHealthService';
import { SLOW_ALERT_AFTER_MS } from '@/domain/quoteWatch';

// 장중 감시 회차 → 띠지 stamp + 지연 지속 알람 (B). 순수 판정(decideSlowPersistAlert)은
// sourceHealth.test.ts가 잰다. 여기서는 **DB에 실제로 상태가 쌓이고 풀리는지**만 본다.

let prisma: PrismaClient;
const H = 3_600_000;

beforeAll(() => {
  prisma = createTestDb('sourcehealthslow-');
});
afterAll(async () => {
  await prisma.$disconnect();
});
// 테스트마다 헬스·지연 상태를 비운다 — 자산군 키가 3개뿐이라 공유하면 순서에 얽힌다
beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'source.' } } });
});

const at = (ms: number) => new Date(ms);

describe('noteQuoteRefreshHealth — 지연 stamp + 지속 알람', () => {
  it('상한 초과(skipped>0)면 띠지에 지연으로 남긴다', async () => {
    await noteQuoteRefreshHealth(
      prisma,
      'KR_EQUITY',
      { watched: 94, refreshed: 60, skipped: 34 },
      at(1000),
    );
    const health = await readSourceHealth(prisma);
    expect(health.KR_EQUITY?.health).toBe('slow');
  });

  it('갱신만 있고 초과가 없으면 정상으로 남기고, 지연 상태를 지운다', async () => {
    // 먼저 지연을 만든 뒤
    await noteQuoteRefreshHealth(prisma, 'US_EQUITY', { watched: 80, refreshed: 60, skipped: 20 }, at(1000));
    expect((await prisma.appSetting.findUnique({ where: { key: 'source.slow.US_EQUITY' } }))).not.toBeNull();
    // 회복되면
    const r = await noteQuoteRefreshHealth(prisma, 'US_EQUITY', { watched: 40, refreshed: 40, skipped: 0 }, at(2000));
    expect(r.fired).toBe(false);
    const health = await readSourceHealth(prisma);
    expect(health.US_EQUITY?.health).toBe('ok');
    // 지연 상태가 지워졌다 → 다음 지연은 처음부터 다시 센다
    expect(await prisma.appSetting.findUnique({ where: { key: 'source.slow.US_EQUITY' } })).toBeNull();
  });

  it('지연이 6시간 연속되면 알린다 — 그 전엔 조용, 실제처럼 관측이 이어질 때', async () => {
    // 실제 감시 갱신은 2분마다 온다. 여기서는 10분(gapReset 12분 이내라 같은 구간 유지)
    // 간격으로 연속 관측을 흉내 낸다 — 관측을 건너뛰면 구간이 리셋된다(그건 아래에서 시험).
    const t0 = 10_000;
    const STEP = 10 * 60_000;
    const slow = { watched: 130, refreshed: 60, skipped: 70 };
    let firstFireAt: number | null = null;
    let fireCount = 0;
    for (let t = t0; t <= t0 + SLOW_ALERT_AFTER_MS + 4 * STEP; t += STEP) {
      const r = await noteQuoteRefreshHealth(prisma, 'CRYPTO', slow, at(t));
      if (r.fired) {
        fireCount++;
        if (firstFireAt === null) firstFireAt = t;
      }
    }
    // 6시간 문턱을 지나서야 처음 울린다 (그 전 관측은 전부 조용)
    expect(firstFireAt).not.toBeNull();
    expect(firstFireAt! - t0).toBeGreaterThanOrEqual(SLOW_ALERT_AFTER_MS);
    expect(firstFireAt! - t0).toBeLessThan(SLOW_ALERT_AFTER_MS + STEP);
    // 문턱을 넘어도 한 번만 (다음 6시간까지 재알림 없음 — 40분 더 관측해도 그대로)
    expect(fireCount).toBe(1);
  });

  it('관측이 오래 끊긴 뒤(장 마감 후 개장)의 지연은 새 구간 — 어제치로 즉시 안 알린다', async () => {
    const t0 = 100_000_000;
    // 어제 종가 근처 지연
    await noteQuoteRefreshHealth(prisma, 'KR_EQUITY', { watched: 94, refreshed: 60, skipped: 34 }, at(t0));
    // 17시간 뒤(장 마감 공백) 오늘 개장 첫 지연 — 새 구간이라 조용해야 한다
    const r = await noteQuoteRefreshHealth(
      prisma,
      'KR_EQUITY',
      { watched: 94, refreshed: 60, skipped: 34 },
      at(t0 + 17 * H),
    );
    expect(r.fired).toBe(false);
  });

  it('감시 대상이 0이면 stamp하지 않는다 — 직전 상태를 덮지 않는다', async () => {
    // KR을 지연으로 만들어 두고
    await noteQuoteRefreshHealth(prisma, 'KR_EQUITY', { watched: 94, refreshed: 60, skipped: 34 }, at(3000));
    // 감시 0 회차가 와도 덮지 않는다
    await noteQuoteRefreshHealth(prisma, 'KR_EQUITY', { watched: 0, refreshed: 0, skipped: 0 }, at(4000));
    const health = await readSourceHealth(prisma);
    expect(health.KR_EQUITY?.health).toBe('slow'); // 직전 지연 유지
  });
});

describe('reportQuoteDelay — 결제 폭주·초당 초과도 같은 지연으로 통합', () => {
  it('결제 폭주를 보고하면 띠지에 지연으로 뜨고 지속 시계가 시작된다', async () => {
    const r = await reportQuoteDelay(
      prisma,
      'KR_EQUITY',
      'PAYMENT_SURGE',
      '결제 관문: 최근 5분 5건 시세 실패',
      at(1000),
    );
    expect(r.fired).toBe(false);
    const health = await readSourceHealth(prisma);
    expect(health.KR_EQUITY?.health).toBe('slow');
    expect(await prisma.appSetting.findUnique({ where: { key: 'source.slow.KR_EQUITY' } })).not.toBeNull();
  });

  it('원인이 달라도(결제→초당초과) 한 지연 구간으로 이어져 6시간에 한 번 알린다', async () => {
    const t0 = 50_000;
    const STEP = 10 * 60_000;
    let fireCount = 0;
    for (let t = t0; t <= t0 + SLOW_ALERT_AFTER_MS + STEP; t += STEP) {
      // 원인을 번갈아 보고해도 dedupeKey가 자산군 단위라 한 구간·한 알람이다
      const cause = (t / STEP) % 2 === 0 ? 'PAYMENT_SURGE' : 'RATE_LIMIT';
      const r = await reportQuoteDelay(prisma, 'US_EQUITY', cause, `원인 ${cause}`, at(t));
      if (r.fired) fireCount++;
    }
    expect(fireCount).toBe(1); // 6시간에 딱 한 번
  });

  it('감시 회차가 정상을 확인하면 결제발 지연도 해제된다 (해제 권한은 감시에만)', async () => {
    // 결제 폭주로 지연 시작
    await reportQuoteDelay(prisma, 'CRYPTO', 'PAYMENT_SURGE', '결제 폭주', at(1000));
    expect((await readSourceHealth(prisma)).CRYPTO?.health).toBe('slow');
    // 감시 회차가 정상(초과 없음)을 확인하면 풀린다
    await noteQuoteRefreshHealth(prisma, 'CRYPTO', { watched: 40, refreshed: 40, skipped: 0 }, at(2000));
    expect((await readSourceHealth(prisma)).CRYPTO?.health).toBe('ok');
    expect(await prisma.appSetting.findUnique({ where: { key: 'source.slow.CRYPTO' } })).toBeNull();
  });
});
