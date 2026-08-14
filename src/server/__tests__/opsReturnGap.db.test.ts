import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { getOpsMetrics, OPS_THRESHOLDS } from '../opsMetrics';

// 지표 ⑥ — **판정을 겪은 뒤 다시 사기까지 걸린 시간** (환불 코호트 vs 적중 코호트).
//
// ④(재구매율)는 사후 지표다. 떨어진 것을 알았을 때는 그 사람들이 이미 떠난 뒤다.
// 이탈은 "안 온다"로 오기 전에 **"점점 늦게 온다"**로 먼저 오므로, 두 코호트의 간격이
// 벌어지기 시작하는 것이 아직 손쓸 수 있는 시점의 신호다.
//
// 재는 축을 새로 만들지 않는다 — 결제 시각과 판정 시각은 이미 있다. 검토받은
// 후보 중 "리포트 완독률"은 계측을 새로 붙여야 하는 데다 이 상황에서는 **거꾸로**
// 작동한다(끝까지 읽고 기다렸다 실패한 사람이 기회비용을 가장 크게 잃었다).
//
// ⚠ 되돌아온 사람만 세는 지표라 **코호트가 통째로 떠나면 간격이 오히려 짧아 보인다.**
// 분모를 반드시 함께 싣고 ④와 같이 읽어야 한다 — 그 성질을 아래 시험이 고정한다.

let prisma: PrismaClient;
let researcherId: string;

const JUDGED_AT = new Date('2026-08-02T00:00:00Z');
const NOW = new Date('2026-10-01T00:00:00Z');
const DAY = 86_400_000;

const find = (ms: Awaited<ReturnType<typeof getOpsMetrics>>, key: string) =>
  ms.find((m) => m.key === key)!;

let seq = 0;

/** 판정된 카드가 달린 리포트 하나 */
async function judgedReport(): Promise<string> {
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
          deadline: JUDGED_AT,
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
      judgedAt: JUDGED_AT,
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
 * 판정을 한 번 겪고 `gapDays` 뒤에 다시 산 사람 하나.
 * `refunded`가 첫 판정이 환불로 끝났는지를 정한다 — 그것이 코호트를 가른다.
 */
async function buyer(email: string, refunded: boolean, gapDays: number | null) {
  const u = await prisma.user.create({ data: { email, identityVerified: true } });
  const first = await prisma.purchase.create({
    data: {
      reportId: await judgedReport(),
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
      settledAt: JUDGED_AT,
    },
  });
  if (gapDays !== null) {
    await prisma.purchase.create({
      data: {
        reportId: await plainReport(),
        buyerId: u.id,
        amountKrw: 10_000,
        paidAt: new Date(JUDGED_AT.getTime() + gapDays * DAY),
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

describe('지표 ⑥ — 판정 후 재구매까지 걸린 시간', () => {
  it('표본이 없으면 숫자를 지어내지 않는다', async () => {
    const m = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    expect(m.value).toBe('—');
    expect(m.alert).toBe(false);
  });

  // 배율은 보이되 경보는 참는다 — 두 사람의 변덕이 5배를 만든다
  it('표본이 얇으면 배율은 보여주되 경보를 울리지 않는다', async () => {
    await buyer('h1@gap.io', false, 4);
    await buyer('f1@gap.io', true, 20);

    const m = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    expect(m.value).toContain('20.0일 / 4.0일');
    expect(m.value).toContain('5.00배');
    expect(m.alert).toBe(false); // 각 1명 < returnGapMinSample
  });

  it('양쪽 표본이 차면 벌어진 간격이 경보가 된다', async () => {
    await buyer('h2@gap.io', false, 5);
    await buyer('h3@gap.io', false, 3);
    await buyer('f2@gap.io', true, 24);
    await buyer('f3@gap.io', true, 30);

    const m = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    // 중앙값: 환불 24일 / 적중 4일 — 평균이 아니라 중앙값인 이유는
    // 표본이 얇을 때 한 사람의 반년이 값을 통째로 끌고 가기 때문이다
    expect(m.value).toContain('24.0일 / 4.0일');
    expect(m.alert).toBe(true);
    expect(OPS_THRESHOLDS.returnGapRatio).toBe(1.5);
  });

  // **되돌아온 사람만 센다.** 코호트가 통째로 떠나면 이 숫자는 오히려 좋아지므로,
  // 분모가 없으면 지표가 아니라 오도다
  it('영영 안 온 사람은 간격에 없다 — 그래서 분모를 함께 싣는다', async () => {
    await buyer('f4@gap.io', true, null); // 환불받고 다시 안 왔다
    await buyer('f5@gap.io', true, null);

    const m = find(await getOpsMetrics(prisma, NOW), 'returnGap');
    // 간격 중앙값은 그대로다 — 떠난 사람이 값을 나쁘게 만들지 못한다
    expect(m.value).toContain('24.0일 / 4.0일');
    // 대신 분모가 그 사실을 말한다: 환불 5명 중 3명만 돌아왔다
    expect(m.sample).toContain('환불 3/5명');
    expect(m.sample).toContain('영영 안 온 사람은 이 숫자에 없습니다');
  });
});
