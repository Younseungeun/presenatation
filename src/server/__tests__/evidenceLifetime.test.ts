import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { researcherSeasonTotals } from '../scoreService';

// 점수는 시즌, 증거는 평생 — 두 값의 **기간이 다르다** (scoreService.ts 상단 주석).
//
// 왜 갈랐나: 상관 보정 뒤 한 시즌의 유효 장수가 2.6장이라 래더가 발동하지 못했다
// (scripts/simDisciplineRealtime.ts). Ville 부등식은 anytime-valid라 창을 늘려도
// 보장이 그대로이고, 오히려 분기 리셋이 연 4α의 다중 검정을 만들고 있었다.

let prisma: PrismaClient;

const Q3 = new Date('2026-08-15T00:00:00Z'); // 직전 시즌
const Q4 = new Date('2026-11-15T00:00:00Z'); // 이번 시즌
const NOW = new Date('2026-11-20T00:00:00Z');

let researcherId: string;

/** 판정된 카드 한 장을 심는다 */
async function seedJudged(opts: {
  publishedAt: Date;
  judgedAt: Date;
  score: number;
  info: number | null;
}): Promise<void> {
  const report = await prisma.report.create({
    data: {
      researcherId,
      title: 't',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      status: 'PUBLISHED',
      publishedAt: opts.publishedAt,
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
          deadline: opts.judgedAt,
        },
      },
    },
    include: { predictionCard: true },
  });
  await prisma.judgment.create({
    data: {
      predictionCardId: report.predictionCard!.id,
      outcome: opts.score >= 0 ? 'HIT' : 'MISS',
      score: opts.score,
      info: opts.info,
      judgedAt: opts.judgedAt,
    },
  });
}

beforeAll(async () => {
  prisma = createTestDb('evidence-lifetime-');
  await seedTestInstruments(prisma);
  const user = await prisma.user.create({
    data: {
      email: 'e@t.io',
      identityVerified: true,
      researcherProfile: { create: { tier: 'BRONZE' } },
    },
    include: { researcherProfile: true },
  });
  researcherId = user.researcherProfile!.id;

  // 직전 시즌: 점수 −500, 정보량 −2.0
  await seedJudged({ publishedAt: new Date('2026-08-01T00:00:00Z'), judgedAt: Q3, score: -500, info: -2 });
  // 이번 시즌: 점수 −300, 정보량 −1.5 (앞 카드와 기간이 겹치지 않는다)
  await seedJudged({ publishedAt: new Date('2026-11-01T00:00:00Z'), judgedAt: Q4, score: -300, info: -1.5 });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('researcherSeasonTotals — 점수는 시즌, 증거는 평생', () => {
  it('점수는 이번 시즌 판정분만 센다', async () => {
    const { score } = await researcherSeasonTotals(prisma, researcherId, NOW);
    expect(score.CRYPTO).toBeCloseTo(-300, 6);
  });

  it('증거는 지난 시즌 것까지 이어 쌓는다 — 리셋하면 표본이 남지 않는다', async () => {
    const { evidence } = await researcherSeasonTotals(prisma, researcherId, NOW);
    // 두 카드는 기간이 겹치지 않아 온전히 각각 세어진다
    expect(evidence.CRYPTO).toBeCloseTo(-3.5, 6);
  });

  it('증거가 이어지면 래더가 닿는다 — 한 시즌만 보면 문턱(−2.30) 위였다', async () => {
    const { evidence } = await researcherSeasonTotals(prisma, researcherId, NOW);
    const { disciplineFor, CONFIDENCE_RANGE } = await import('@/domain/scoring');
    expect(disciplineFor(-1.5).maxConfidence).toBe(CONFIDENCE_RANGE.max); // 이번 시즌만
    expect(disciplineFor(evidence.CRYPTO).maxConfidence).toBe(6); // 이어 쌓으면 1단
  });

  it('과거 시즌을 기준 시각으로 주면 그 이후 판정은 새어 들어오지 않는다', async () => {
    const past = await researcherSeasonTotals(prisma, researcherId, Q3);
    expect(past.score.CRYPTO).toBeCloseTo(-500, 6); // 그 시즌 점수
    expect(past.evidence.CRYPTO).toBeCloseTo(-2, 6); // 그 시점까지의 증거만
  });
});
