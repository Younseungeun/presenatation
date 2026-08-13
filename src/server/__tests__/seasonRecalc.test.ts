import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { recalcSeasonTiers } from '../seasonRecalcService';
import { nextSeasonStart, seasonStart } from '../scoreService';

// 시즌 재산정 통합 테스트: 직전 시즌(2026-Q3) 점수로 2026-10-01 재산정을 실행한다

let prisma: PrismaClient;

const IN_Q3 = new Date('2026-08-15T00:00:00Z'); // 직전 시즌 내 판정 시각
const RECALC_AT = new Date('2026-10-05T00:00:00Z'); // Q4 진입 후 실행

/** 리서처 1명 + 직전 시즌 판정 점수를 심는다 */
async function seedResearcher(email: string, tier: string, q3Score: number | null) {
  const user = await prisma.user.create({
    data: {
      email,
      identityVerified: true,
      researcherProfile: { create: { tier } },
    },
    include: { researcherProfile: true },
  });
  const researcherId = user.researcherProfile!.id;

  if (q3Score !== null) {
    const report = await prisma.report.create({
      data: {
        researcherId,
        title: 't',
        summary: 's',
        content: 'c',
        priceKrw: 10_000,
        status: 'PUBLISHED',
        publishedAt: new Date('2026-07-20T00:00:00Z'),
        feeRateBp: 2000,
        predictionCard: {
          create: {
            assetClass: 'CRYPTO',
            ticker: 'KRW-BTC',
            currency: 'KRW',
            assetName: 'BTC',
            direction: 'UP',
            targetType: 'RETURN_PCT',
            targetValue: 10,
            basePrice: 100,
            deadline: new Date('2026-08-10T00:00:00Z'),
          },
        },
      },
      include: { predictionCard: true },
    });
    await prisma.judgment.create({
      data: {
        predictionCardId: report.predictionCard!.id,
        outcome: q3Score >= 0 ? 'HIT' : 'MISS',
        score: q3Score,
        judgedAt: IN_Q3,
      },
    });
  }
  return researcherId;
}

beforeAll(async () => {
  prisma = createTestDb('season-recalc-');
  await seedTestInstruments(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('시즌 경계 계산', () => {
  it('KST 기준 분기 경계', () => {
    // 2026-10-01 00:00 KST = 2026-09-30 15:00 UTC
    expect(seasonStart(RECALC_AT).toISOString()).toBe('2026-09-30T15:00:00.000Z');
    expect(nextSeasonStart(new Date('2026-08-15T00:00:00Z')).toISOString()).toBe(
      '2026-09-30T15:00:00.000Z',
    );
  });
});

describe('recalcSeasonTiers — 직전 시즌 점수로 전면 재평가', () => {
  it('승급·강등·유지를 한 번에 처리하고 TierHistory에 기록', async () => {
    const promoteId = await seedResearcher('p@t.io', 'BRONZE', 2_000); // 시니어(1,330+) 승급
    const demoteId = await seedResearcher('d@t.io', 'GOLD', 800); // 점수 미달 → 무표기 강등
    const keepId = await seedResearcher('k@t.io', 'BRONZE', 400); // 유지
    const idleId = await seedResearcher('i@t.io', 'PLATINUM', null); // 활동 없음 → 강등

    const summary = await recalcSeasonTiers(prisma, RECALC_AT);
    expect(summary.season).toBe('2026-Q3');
    expect(summary.evaluated).toBe(4);
    expect(summary.promoted).toBe(1);
    expect(summary.demoted).toBe(2);
    expect(summary.unchanged).toBe(1);

    const tiers = Object.fromEntries(
      (await prisma.researcherProfile.findMany()).map((p) => [p.id, p.tier]),
    );
    expect(tiers[promoteId]).toBe('SILVER');
    expect(tiers[demoteId]).toBe('BRONZE');
    expect(tiers[keepId]).toBe('BRONZE');
    expect(tiers[idleId]).toBe('BRONZE'); // 시즌 무활동 = 0점 → 최하 등급

    const promoteHistory = await prisma.tierHistory.findFirstOrThrow({
      where: { researcherId: promoteId },
    });
    expect(promoteHistory).toMatchObject({
      season: '2026-Q3',
      fromTier: 'BRONZE',
      toTier: 'SILVER',
      reason: 'PROMOTION',
    });
    const demoteHistory = await prisma.tierHistory.findFirstOrThrow({
      where: { researcherId: demoteId },
    });
    expect(demoteHistory.reason).toBe('DEMOTION');

    // 유지된 리서처는 이력 없음 (변경만 기록)
    expect(await prisma.tierHistory.count({ where: { researcherId: keepId } })).toBe(0);
  });

  it('새 시즌 점수는 0에서 시작 — 직전 시즌 점수가 새어 들어오지 않음', async () => {
    // RECALC_AT(Q4) 기준 현재 시즌 점수 조회 시 Q3 판정은 제외되어야 한다
    const { researcherSeasonScores } = await import('../scoreService');
    const anyProfile = await prisma.researcherProfile.findFirstOrThrow();
    const q4Scores = await researcherSeasonScores(prisma, anyProfile.id, RECALC_AT);
    expect(Object.values(q4Scores).every((s) => s === 0)).toBe(true);
  });
});
