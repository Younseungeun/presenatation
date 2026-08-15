import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { buildJudgmentWrites, type CardWithHeldPurchases } from '../judgmentWriter';

// **판정 트랜잭션의 문장 수는 구매 건수에 비례하면 안 된다** (2026-08-16).
//
// ── 무엇이 무너뜨리는가 ─────────────────────────────────────────
// `measureWriteContention`이 실측한 것은 "트랜잭션 안에서 I/O를 하면 죽는다"가 아니라
// **"트랜잭션이 길면 죽는다"**였다 — 대조군(트랜잭션 안에서 시간을 끄는 경우)은
// p99 16초·결제 실패 2건으로 전멸했고 정상군은 8벌까지 실패 0건이었다. I/O는 길어지는
// 흔한 원인일 뿐이고, **문장 수만으로도 같은 곳에 도달한다.**
//
// 구매 1건마다 정산·구매 상태·알림·보상을 따로 쓰면 구매 500건이 **2,000문장**이다.
// `noIoInTransaction` 불변식은 I/O만 보므로 이쪽은 아무도 막아 주지 않았다.
//
// ── 왜 문장 수를 시험하는가 ─────────────────────────────────────
// 성능을 재는 시험이 아니다. 재면 기계마다 달라 문턱을 못 정한다. 재는 것은 **기울기**다 —
// 구매가 늘어도 문장이 안 늘면 이 실패 모양은 구조적으로 닫힌다. 그리고 이 시험이
// 없으면 다음에 구매당 쓰기를 하나 더 얹는 사람을 아무것도 막지 못한다
// (보상 지시서를 붙일 때 실제로 그럴 뻔했다).

let prisma: PrismaClient;
let researcherUserId: string;
let reportId: string;

const NOW = new Date('2026-08-16T00:00:00Z');
const PRICE_KRW = 10_000;

/** 구매 N건짜리 카드를 만들어 판정 쓰기 배열을 뽑는다 (실행하지 않는다) */
async function cardWith(purchases: number): Promise<CardWithHeldPurchases> {
  const card = await prisma.predictionCard.findFirstOrThrow({ where: { reportId } });
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { researcher: { select: { userId: true } } },
  });
  // 구매 행은 시험이 세는 대상이 아니라 **입력**이다 — 실제로 저장할 필요가 없다
  const rows = Array.from({ length: purchases }, (_, i) => ({
    id: `p_${purchases}_${i}`,
    reportId,
    buyerId: `b_${purchases}_${i}`,
    amountKrw: PRICE_KRW,
    paymentMethod: 'CARD',
    paymentInfo: null,
    paymentKey: null,
    priceGate: null,
    escrowStatus: 'HELD',
    paidAt: NOW,
    salesCloseAckAt: null,
  }));
  return { ...card, report: { ...report, purchases: rows } } as CardWithHeldPurchases;
}

function writeCount(card: CardWithHeldPurchases, dataSource: string) {
  return buildJudgmentWrites(
    prisma,
    card,
    {
      result: { outcome: 'MISS', peakProgress: 0.3 },
      realizedReturnPct: -5,
      score: -50,
      info: -0.5,
      dataSource,
      audit: {},
      resolvedBasePrice: null,
    },
    NOW,
  ).length;
}

beforeAll(async () => {
  prisma = createTestDb('judge-fanout-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@fanout.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherUserId = r.id;
  const report = await prisma.report.create({
    data: {
      researcherId: r.researcherProfile!.id,
      title: '팬아웃 전망',
      summary: 's',
      content: 'c',
      priceKrw: PRICE_KRW,
      prepaymentRatio: 0,
      feeRateBp: 2_000,
      status: 'PUBLISHED',
      publishedAt: NOW,
      predictionCard: {
        create: {
          assetClass: 'CRYPTO',
          ticker: 'KRW-AAA',
          assetName: 'AAA',
          direction: 'UP',
          targetType: 'RETURN_PCT',
          targetValue: 20,
          confidence: 5,
          selfStability: 1,
          deadline: new Date('2026-09-01T00:00:00Z'),
        },
      },
    },
  });
  reportId = report.id;
  expect(researcherUserId).toBeTruthy();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('판정 트랜잭션의 기울기', () => {
  // **이것이 이 파일의 전부다.** 구매가 20배로 늘어도 문장 수가 같아야 한다
  it('구매가 1건이든 200건이든 문장 수가 같다', async () => {
    const one = writeCount(await cardWith(1), 'upbit');
    const many = writeCount(await cardWith(200), 'upbit');
    expect(many).toBe(one);
  });

  // 보상 지시서가 붙는 경로(하드캡)에서도 기울기가 서면 안 된다 —
  // 새 표를 만들면서 정확히 여기를 세울 뻔했다
  it('보상 지시서가 붙는 하드캡 경로에서도 같다', async () => {
    const one = writeCount(await cardWith(1), 'hard-cap');
    const many = writeCount(await cardWith(200), 'hard-cap');
    expect(many).toBe(one);
    // 보상이 붙으므로 정상 판정보다 딱 한 문장 많다 (createMany 하나)
    expect(one).toBe(writeCount(await cardWith(1), 'upbit') + 1);
  });

  // 구매가 없는 카드는 정산도 알림(구매자)도 없다 — 판정과 리서처 알림만 남는다
  it('구매가 없으면 정산·구매 상태 문장이 아예 없다', async () => {
    const none = writeCount(await cardWith(0), 'upbit');
    expect(none).toBeLessThan(writeCount(await cardWith(1), 'upbit'));
  });

  // 실제 상한 — 문장 수가 한 자릿수를 넘으면 접는 것을 잊었다는 뜻이다.
  // 숫자를 박아 두는 이유는 "기울기 0"만으로는 절편이 커지는 것을 못 잡기 때문
  it('어떤 경로로도 한 판정이 10문장을 넘지 않는다', async () => {
    for (const src of ['upbit', 'hard-cap', 'hard-cap:paused', 'manual:op-1']) {
      expect(writeCount(await cardWith(500), src)).toBeLessThanOrEqual(10);
    }
  });
});
