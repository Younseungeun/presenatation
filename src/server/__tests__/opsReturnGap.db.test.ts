import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { getOpsMetrics, OPS_THRESHOLDS, RETURN_HORIZON_DAYS } from '../opsMetrics';

// 지표 ⑥ — **판정 후 14일 안에 다시 샀는가** (환불 코호트 vs 적중 코호트).
//
// ── 첫 구현을 버린 이유 (2026-08-15) ─────────────────────────
// 처음에는 되돌아온 사람의 **재구매 간격 중앙값**을 두 코호트로 나눠 봤다. 우측 절단
// 때문에 **통계적으로 유해한 지표**였다: 영영 안 온 사람은 간격이 없어 분자에도 분모에도
// 안 들어가고, 그래서 **코호트가 통째로 떠날수록 숫자가 오히려 좋아진다.**
// 분모를 함께 싣고 ④와 같이 읽는 것으로 막아 뒀었는데, 그건 읽는 사람의 규율에
// 기대는 방어라 언젠가 뚫린다.
//
// 고정 지평은 그 구멍을 **정의로** 닫는다 — 떠난 사람이 분모에 남으므로 이탈이 늘면
// 숫자가 내려간다. 아래 마지막 시험이 정확히 그 방향을 고정한다(옛 구현이라면 이
// 시험이 반대로 움직인다).

let prisma: PrismaClient;
let researcherId: string;

const JUDGED_AT = new Date('2026-08-02T00:00:00Z');
const NOW = new Date('2026-10-01T00:00:00Z');
const DAY = 86_400_000;

const find = (ms: Awaited<ReturnType<typeof getOpsMetrics>>, key: string) =>
  ms.find((m) => m.key === key)!;

let seq = 0;

/** 판정된 카드가 달린 리포트 하나 */
async function judgedReport(judgedAt: Date): Promise<string> {
  seq += 1;
  const report = await prisma.report.create({
    data: {
      researcherId,
      title: `r${seq}`,
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      status: 'PUBLISHED',
      publishedAt: new Date('2026-07-12T00:00:00Z'),
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
          deadline: judgedAt,
        },
      },
    },
    include: { predictionCard: true },
  });
  await prisma.judgment.create({
    data: {
      predictionCardId: report.predictionCard!.id,
      outcome: 'MISS',
      score: -100,
      info: -1,
      judgedAt,
    },
  });
  return report.id;
}

/** 아직 판정되지 않은 리포트 — "다시 산 것"의 대상 */
async function plainReport(): Promise<string> {
  seq += 1;
  const r = await prisma.report.create({
    data: {
      researcherId,
      title: `p${seq}`,
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      status: 'PUBLISHED',
      publishedAt: new Date('2026-08-10T00:00:00Z'),
      feeRateBp: 2000,
    },
  });
  return r.id;
}

/**
 * 판정을 한 번 겪은 사람 하나.
 * `gapDays`가 null이면 다시 안 왔다는 뜻이고, `judgedAt`으로 관측 창을 열고 닫는다.
 */
async function buyer(
  email: string,
  refunded: boolean,
  gapDays: number | null,
  judgedAt = JUDGED_AT,
) {
  const u = await prisma.user.create({ data: { email, identityVerified: true } });
  const first = await prisma.purchase.create({
    data: {
      reportId: await judgedReport(judgedAt),
      buyerId: u.id,
      amountKrw: 10_000,
      escrowStatus: refunded ? 'REFUNDED' : 'SETTLED',
      paidAt: new Date('2026-07-12T00:00:00Z'),
    },
  });
  await prisma.settlement.create({
    data: {
      purchaseId: first.id,
      outcome: refunded ? 'MISS' : 'HIT',
      researcherPayoutKrw: refunded ? 0 : 8_000,
      platformFeeKrw: refunded ? 0 : 2_000,
      buyerRefundKrw: refunded ? 10_000 : 0,
      settledAt: judgedAt,
    },
  });
  if (gapDays !== null) {
    await prisma.purchase.create({
      data: {
        reportId: await plainReport(),
        buyerId: u.id,
        amountKrw: 10_000,
        paidAt: new Date(judgedAt.getTime() + gapDays * DAY),
      },
    });
  }
}

beforeAll(async () => {
  prisma = createTestDb('ops-return-gap-');
  await seedTestInstruments(prisma);
  const r = await prisma.user.create({
    data: { email: 'r@gap.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('지표 ⑥ — 판정 후 14일 내 재구매율', () => {
  it('표본이 없으면 숫자를 지어내지 않는다', async () => {
    const m = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    expect(m.value).toBe('—');
    expect(m.alert).toBe(false);
  });

  // **창이 안 닫힌 사람은 분모에 없다.** 넣으면 "아직 안 온 것"과 "영영 안 올 것"이
  // 같은 칸에 들어가 지표가 늘 나쁘게 보인다
  it('관측 창이 아직 안 닫힌 사람은 분모에 넣지 않는다', async () => {
    // 판정이 어제라 14일이 안 지났다
    await buyer('fresh@gap.io', true, null, new Date(NOW.getTime() - 1 * DAY));

    const m = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    expect(m.value).toBe('—'); // 셀 수 있는 사람이 아직 없다
    expect(m.sample).toContain('환불 0명 중 0명');
  });

  it('창 안에 다시 산 사람만 분자에 넣는다 — 창 밖 재구매는 세지 않는다', async () => {
    await buyer('h1@gap.io', false, 4); // 적중 · 4일 만에 재구매 → 분자
    await buyer('f1@gap.io', true, 20); // 환불 · 20일 만에 → 창 밖이라 분자 아님

    const m = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    expect(m.value).toContain('0.0% / 100.0%');
    expect(m.alert).toBe(false); // 각 1명 < returnGapMinSample
    expect(RETURN_HORIZON_DAYS).toBe(14);
  });

  it('양쪽 표본이 차면 벌어진 격차가 경보가 된다', async () => {
    await buyer('h2@gap.io', false, 5);
    await buyer('h3@gap.io', false, 3);
    await buyer('f2@gap.io', true, 2); // 환불군에서 하나만 돌아온다
    await buyer('f3@gap.io', true, 30);

    const m = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    // 환불 3명 중 1명(33.3%) / 적중 3명 중 3명(100%) → 3.00배
    expect(m.value).toContain('33.3% / 100.0%');
    expect(m.value).toContain('3.00배');
    expect(m.alert).toBe(true);
    expect(OPS_THRESHOLDS.returnGapRatio).toBe(1.5);
  });

  // **이것이 옛 구현을 버린 이유다.** 간격 중앙값이었다면 떠난 사람이 값에서 빠져
  // 숫자가 그대로거나 오히려 좋아졌다. 고정 지평에서는 분모에 남아 내려간다
  it('영영 안 온 사람이 늘면 숫자가 내려간다 — 방향이 바로 서 있다', async () => {
    const before = find(await getOpsMetrics(prisma, NOW), 'returnGap').value;

    await buyer('f4@gap.io', true, null);
    await buyer('f5@gap.io', true, null);

    const after = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    expect(after.value).toContain('20.0%'); // 환불 5명 중 1명
    expect(before).toContain('33.3%');
    expect(after.sample).toContain('환불 5명 중 1명');
  });
});
