import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { ABUSE_SUSPEND_REPORTERS } from '@/domain/abuseSuspension';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  AbuseReportError,
  createAbuseReport,
  getReportAbuseNotice,
  isAbuseSuspended,
  reviewAbuseReport,
} from '../abuseReportService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';

// 신고를 리포트에 붙이면 생기는 세 가지 (2026-08-19):
//   ① 같은 사람은 같은 리포트를 두 번 신고할 수 없다
//   ② 중복 고지 — "이미 접수된 신고가 있다"를, **개수 없이**
//   ③ 서로 다른 신고자가 문턱만큼 모이면 **가역적 판매 중단**
//
// 이 파일이 지키는 진짜 명제는 하나다: **한 사람의 말로는 남의 판매가 멈추지 않는다.**

let prisma: PrismaClient;
let researcherId: string;
let reportId: string;
let buyerId: string;
const reporters: string[] = [];

const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const NOW = new Date('2026-07-20T00:00:00Z');

function registry(ticker: string): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
      { date: '2026-07-12', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ]),
  };
}

beforeAll(async () => {
  prisma = createTestDb('abuse-susp-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@abuse.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@abuse.io', identityVerified: true } }))
    .id;

  // 신고자는 문턱보다 한 명 더 만든다 — 문턱을 넘는 순간과 그 앞을 둘 다 재려면
  // 마지막 한 명이 남아 있어야 한다
  for (let i = 0; i < ABUSE_SUSPEND_REPORTERS + 1; i++) {
    const u = await prisma.user.create({
      data: { email: `rep${i}@abuse.io`, identityVerified: true },
    });
    reporters.push(u.id);
  }

  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: '비트코인 4분기 전망',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker: 'KRW-AAA',
        assetName: 'KRW-AAA',
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 20,
        confidence: 5,
        selfStability: 5,
        deadline: new Date('2026-12-01T00:00:00Z'),
      },
    },
    new Date('2026-07-11T00:00:00Z'),
  );
  await publishReport(prisma, registry('KRW-AAA'), draft.id, researcherId, PUBLISH_NOW);
  reportId = draft.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('① 같은 사람은 같은 리포트를 두 번 신고할 수 없다', () => {
  it('두 번째 신고는 사람이 읽는 말로 거절된다', async () => {
    await createAbuseReport(
      prisma,
      { reporterId: reporters[0], reportId, targetName: 't', category: 'SOLICIT', detail: '수익 보장 표현이 있습니다' },
      NOW,
    );
    await expect(
      createAbuseReport(
        prisma,
        { reporterId: reporters[0], reportId, targetName: 't', category: 'SOLICIT', detail: '한 번 더 신고합니다' },
        NOW,
      ),
    ).rejects.toThrow(AbuseReportError);
  });

  // **이것이 없으면 문턱이 무의미하다** — 하루 신고 한도가 정확히 3이라
  // 한 사람이 3번 눌러 혼자서 중단을 걸 수 있다
  it('혼자 여러 번 신고해도 판매는 멈추지 않는다', async () => {
    expect(await isAbuseSuspended(prisma, reportId)).toBe(false);
  });
});

describe('② 중복 고지 — 있다/없다만 말한다', () => {
  it('이미 신고가 있으면 알리고, 보상 대상이 아니라고 미리 말한다', async () => {
    const notice = await getReportAbuseNotice(prisma, reportId, reporters[1]);
    expect(notice.alreadyReported).toBe(true);
    expect(notice.byViewer).toBe(false);
    expect(notice.rewardEligible).toBe(false);
  });

  it('본인이 이미 신고했으면 그렇다고 말한다', async () => {
    const notice = await getReportAbuseNotice(prisma, reportId, reporters[0]);
    expect(notice.byViewer).toBe(true);
  });

  // **개수를 흘리면 담합하는 쪽이 자기 진도를 잰다.** 문턱이 3인 것을 아는 사람은
  // "2건 접수됨"을 보고 정확히 한 명만 더 부른다 — 고지가 공격의 계기판이 된다.
  // 그래서 반환값에 수를 담을 자리 자체를 두지 않는다
  it('건수는 어떤 형태로도 밖으로 나가지 않는다', async () => {
    const notice = await getReportAbuseNotice(prisma, reportId, reporters[1]);
    expect(Object.keys(notice).sort()).toEqual(['alreadyReported', 'byViewer', 'rewardEligible']);
    for (const v of Object.values(notice)) expect(typeof v).toBe('boolean');
  });
});

describe('③ 서로 다른 신고자가 모이면 가역적 판매 중단', () => {
  it('문턱 직전까지는 그대로 팔린다', async () => {
    // reporters[0]은 위에서 이미 신고했다 — 문턱보다 하나 적게 채운다
    for (let i = 1; i < ABUSE_SUSPEND_REPORTERS - 1; i++) {
      await createAbuseReport(
        prisma,
        { reporterId: reporters[i], reportId, targetName: 't', category: 'SOLICIT', detail: '같은 위반을 봤습니다' },
        NOW,
      );
    }
    expect(await isAbuseSuspended(prisma, reportId)).toBe(false);
    await expect(purchaseReport(prisma, reportId, buyerId, NOW)).resolves.toBeTruthy();
  });

  it('문턱에 닿으면 결제 관문이 막고, 리서처에게 알린다', async () => {
    await createAbuseReport(
      prisma,
      {
        reporterId: reporters[ABUSE_SUSPEND_REPORTERS - 1],
        reportId,
        targetName: 't',
        category: 'SOLICIT',
        detail: '저도 같은 것을 봤습니다',
      },
      NOW,
    );
    expect(await isAbuseSuspended(prisma, reportId)).toBe(true);

    const other = await prisma.user.create({
      data: { email: 'b2@abuse.io', identityVerified: true },
    });
    await expect(purchaseReport(prisma, reportId, other.id, NOW)).rejects.toThrow(/일시 중단/);

    const researcherUserId = (
      await prisma.researcherProfile.findUniqueOrThrow({ where: { id: researcherId } })
    ).userId;
    const notes = await prisma.notification.findMany({
      where: { userId: researcherUserId, type: 'ABUSE_SALES_SUSPENDED' },
    });
    // **본인만 모르는 상태가 가장 나쁘다** — 판매가 멈췄으면 반드시 알린다
    expect(notes).toHaveLength(1);
  });

  it('중단은 가역이다 — 기각하면 다시 팔린다', async () => {
    const operator = await prisma.user.create({
      data: { email: 'op@abuse.io', identityVerified: true, role: 'OPERATOR' },
    });
    const pending = await prisma.abuseReport.findMany({ where: { reportId, status: 'PENDING' } });
    // 하나만 기각해도 서로 다른 신고자 수가 문턱 아래로 내려간다
    await reviewAbuseReport(
      prisma,
      { id: pending[0].id, operatorUserId: operator.id, decision: 'REJECTED', note: '위반 아님' },
      NOW,
    );
    expect(await isAbuseSuspended(prisma, reportId)).toBe(false);

    const buyer3 = await prisma.user.create({
      data: { email: 'b3@abuse.io', identityVerified: true },
    });
    await expect(purchaseReport(prisma, reportId, buyer3.id, NOW)).resolves.toBeTruthy();
  });
});

describe('보상은 리포트별로 첫 신고자에게만', () => {
  it('같은 리포트의 두 번째 확인은 보상 대상이 아니다', async () => {
    const operator = await prisma.user.findFirstOrThrow({ where: { role: 'OPERATOR' } });
    const pending = await prisma.abuseReport.findMany({
      where: { reportId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    expect(pending.length).toBeGreaterThanOrEqual(2);

    const first = await reviewAbuseReport(
      prisma,
      { id: pending[0].id, operatorUserId: operator.id, decision: 'CONFIRMED', note: '확인' },
      NOW,
    );
    const second = await reviewAbuseReport(
      prisma,
      { id: pending[1].id, operatorUserId: operator.id, decision: 'CONFIRMED', note: '확인' },
      NOW,
    );

    // 전에는 선착순 쿼터가 플랫폼 전체 100건뿐이라 같은 리포트를 신고한 5명이
    // 쿼터를 5개 먹었다. 무엇보다 화면이 두 번째 신고자에게 "보상은 먼저 신고한
    // 분에게 갑니다"라고 먼저 말하므로, 여기서 집행하지 않으면 그 고지가 거짓말이 된다
    expect(first.rewarded).toBe(true);
    expect(second.rewarded).toBe(false);
  });
});
