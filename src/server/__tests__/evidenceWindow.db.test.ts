import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { researcherSeasonTotals } from '../scoreService';

// **규율 래더의 입력은 인프라 사고에 흔들리면 안 된다 (2026-08-15).**
//
// 겹침 보정이 재는 것은 "B를 신고할 때 A의 결과를 알았는가"다. 리서처는 우리 배치를
// 기다려 아는 것이 아니라 시한의 종가로 스스로 안다 — 그러니 카드가 닫힌 시각은
// **결과가 정해진 시각**이지 배치가 돈 시각이 아니다.
//
// judgedAt을 그대로 쓰면 KIS 장애·재부팅·큐 정체가 그대로 겹침을 늘리고, 겹치면
// 하중이 커지고, 하중이 커지면 증거가 깎인다. 즉 **시세 공급자가 흔들린 날 규율이
// 무뎌진다.** 그런 연결은 있어서는 안 된다.
//
// 규칙은 min(판정 시각, 시한) 하나다 — 시한으로 못 박으면 도달 판정(목표에 닿은 날
// 결과가 확정되는 카드)이 그 뒤 몇 달을 "열린 채"로 세어진다.

let prisma: PrismaClient;
let researcherId: string;

const NOW = new Date('2026-06-01T00:00:00Z');

interface Seed {
  publishedAt: Date;
  deadline: Date;
  judgedAt: Date;
  info: number | null;
  outcome?: string;
}

async function seedCard(s: Seed): Promise<void> {
  const report = await prisma.report.create({
    data: {
      researcherId,
      title: 't',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      status: 'PUBLISHED',
      publishedAt: s.publishedAt,
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
          deadline: s.deadline,
        },
      },
    },
    include: { predictionCard: true },
  });
  await prisma.judgment.create({
    data: {
      predictionCardId: report.predictionCard!.id,
      outcome: s.outcome ?? 'MISS',
      score: -100,
      info: s.info,
      judgedAt: s.judgedAt,
    },
  });
}

async function evidence(): Promise<number> {
  const { evidence: e } = await researcherSeasonTotals(prisma, researcherId, NOW);
  return e.CRYPTO;
}

async function reset(): Promise<void> {
  await prisma.judgment.deleteMany({});
  await prisma.predictionCard.deleteMany({});
  await prisma.report.deleteMany({});
}

const d = (s: string) => new Date(`${s}T00:00:00Z`);

beforeAll(async () => {
  prisma = createTestDb('evidence-window-');
  await seedTestInstruments(prisma);
  const user = await prisma.user.create({
    data: {
      email: 'w@t.io',
      identityVerified: true,
      researcherProfile: { create: { tier: 'BRONZE' } },
    },
    include: { researcherProfile: true },
  });
  researcherId = user.researcherProfile!.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('증거의 겹침은 약정한 기간으로 잰다', () => {
  it('판정이 늦어도 증거가 깎이지 않는다 — 배치 지연은 카드의 사실이 아니다', async () => {
    await reset();
    // 두 카드는 **약정 기간이 붙어 있을 뿐 겹치지 않는다** (2/1 마감 → 2/2 게시).
    // A의 판정이 9일 밀린 상태 — 옛 규칙이면 A가 2/10까지 열려 있어 B와 8일 겹친다
    await seedCard({
      publishedAt: d('2026-01-01'),
      deadline: d('2026-02-01'),
      judgedAt: d('2026-02-10'),
      info: -2,
    });
    await seedCard({
      publishedAt: d('2026-02-02'),
      deadline: d('2026-03-01'),
      judgedAt: d('2026-03-01'),
      info: -1.5,
    });

    // 겹침이 없으므로 두 카드가 온전히 세어진다
    expect(await evidence()).toBeCloseTo(-3.5, 6);
  });

  it('도달 판정은 시한이 아니라 실제로 닫힌 날로 센다', async () => {
    await reset();
    // A는 4/1이 시한이지만 1/15에 목표에 닿아 그날 확정됐다(도달 판정).
    // "무조건 시한"으로 고정했다면 A가 4/1까지 열린 것으로 세어져 B를 통째로 삼킨다
    await seedCard({
      publishedAt: d('2026-01-01'),
      deadline: d('2026-04-01'),
      judgedAt: d('2026-01-15'),
      info: -2,
      outcome: 'HIT',
    });
    await seedCard({
      publishedAt: d('2026-02-01'),
      deadline: d('2026-03-01'),
      judgedAt: d('2026-03-01'),
      info: -1.5,
    });

    expect(await evidence()).toBeCloseTo(-3.5, 6);
  });

  it('진짜로 겹친 카드는 그대로 깎인다 — 보정을 끄는 변경이 아니다', async () => {
    await reset();
    // 같은 기간에 완전히 포개진 두 장 — 하중이 정확히 2라 평균 한 항이 된다
    for (const info of [-2, -2]) {
      await seedCard({
        publishedAt: d('2026-01-01'),
        deadline: d('2026-02-01'),
        judgedAt: d('2026-02-03'),
        info,
      });
    }

    expect(await evidence()).toBeCloseTo(-2, 6);
  });

  it('판정 불가 카드는 남의 증거를 깎지 못한다 — 증거가 아닌 것에 상관될 것이 없다', async () => {
    await reset();
    await seedCard({
      publishedAt: d('2026-01-01'),
      deadline: d('2026-02-01'),
      judgedAt: d('2026-02-03'),
      info: -2,
    });
    // 같은 기간에 포개진 판정 불가(info 0) — D에는 0을 더하면서 하중만 키우던 자리다.
    // 남겨 두면 "카드를 뿌리고 철회한다"가 규율을 희석하는 경로가 된다
    await seedCard({
      publishedAt: d('2026-01-01'),
      deadline: d('2026-02-01'),
      judgedAt: d('2026-02-03'),
      info: 0,
      outcome: 'UNDECIDABLE',
    });

    expect(await evidence()).toBeCloseTo(-2, 6);
  });
});
