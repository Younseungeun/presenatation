import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { ABUSE_SUSPEND_REPORTERS } from '@/domain/abuseSuspension';
import {
  ABUSE_REJECTED_REPORTER_BODY,
  ABUSE_REPLY_TITLE,
  ABUSE_RESUME_BODY,
  ABUSE_RESUME_TITLE,
} from '@/domain/notice';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { createAbuseReport, getAbuseReports, isAbuseSuspended } from '../abuseReportService';
import { resolveAbuseReportGroup } from '../abuseResolveService';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import { storeTeacherPackForReport } from '../teacherPackStore';
import { getTeacherAnswerPending } from '../teacherAnswerQueue';

// 신고 그룹 처리 — **판단 하나가 전부를 정한다** (2026-08-19 사용자 확정).
//
// 이 파일이 지키는 명제: "위반 확인"을 누른 순간과 리포트가 내려간 순간 사이에
// **위반이 확인된 리포트가 팔리는 시간이 없다.** 예전에는 확인이 PENDING을 줄여
// 판매 중단이 풀렸고, 철회는 다른 화면의 다른 버튼이었다.

let prisma: PrismaClient;
let researcherId: string;
let researcherUserId: string;
const reporters: string[] = [];
let operatorId: string;

const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const NOW = new Date('2026-07-20T00:00:00Z');

function registry(ticker: string): ProviderRegistry {
  return {
    CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
      { date: '2026-07-12', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ]),
  };
}

async function publishTarget(title: string): Promise<string> {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title,
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
  return draft.id;
}

async function fileGroup(reportId: string) {
  for (let i = 0; i < ABUSE_SUSPEND_REPORTERS; i++) {
    await createAbuseReport(
      prisma,
      {
        reporterId: reporters[i],
        reportId,
        targetName: 't',
        category: 'OUTSIDE_CHANNEL',
        detail: '오픈채팅으로 유도하는 문구를 봤습니다',
      },
      NOW,
    );
  }
}

beforeAll(async () => {
  prisma = createTestDb('abuse-resolve-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@resolve.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  researcherUserId = r.id;
  operatorId = (
    await prisma.user.create({
      data: { email: 'op@resolve.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;
  for (let i = 0; i < ABUSE_SUSPEND_REPORTERS; i++) {
    const u = await prisma.user.create({
      data: { email: `rep${i}@resolve.io`, identityVerified: true },
    });
    reporters.push(u.id);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('확인 = 철회·환불·미탐·통지·보상이 한 번에', () => {
  it('전 과정이 판단 한 번으로 끝나고, 확인 뒤 팔리는 틈이 없다', async () => {
    const reportId = await publishTarget('확인 대상 리포트');
    // 신고 전에 산 사람 — 철회가 이 돈을 돌려줘야 한다
    const buyer = await prisma.user.create({
      data: { email: 'b1@resolve.io', identityVerified: true },
    });
    await purchaseReport(prisma, reportId, buyer.id, NOW);
    await fileGroup(reportId);
    expect(await isAbuseSuspended(prisma, reportId)).toBe(true);

    const summary = await resolveAbuseReportGroup(
      prisma,
      {
        reportId,
        operatorUserId: operatorId,
        decision: 'CONFIRMED',
        note: '본문에 오픈채팅 유도 문구 확인',
        categories: ['SOLICIT_CONTACT'],
        // 근거 문장 지목 (2026-08-28) — 미탐 재학습 지역화의 근거
        evidence: ['오픈채팅방에서 안내드립니다'],
      },
      NOW,
    );

    // ① 철회 — 리포트가 닫히고 에스크로가 전액 환불 대상이 된다
    expect(summary.takedown).not.toBeNull();
    expect(summary.takedown!.refundedPurchases).toBe(1);
    expect(summary.takedownSkipped).toBeNull();
    const report = await prisma.report.findUniqueOrThrow({
      where: { id: reportId },
      include: { predictionCard: true },
    });
    expect(report.status).toBe('CLOSED');
    expect(report.predictionCard!.withdrawnAt).not.toBeNull();

    // ② 신고 전원 확정 + 첫 신고자만 보상 (리포트별 첫 신고자 규칙)
    expect(summary.resolved).toBe(ABUSE_SUSPEND_REPORTERS);
    expect(summary.rewarded).toBe(true);
    const rows = await prisma.abuseReport.findMany({
      where: { reportId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.every((r) => r.status === 'CONFIRMED')).toBe(true);
    expect(rows.map((r) => r.rewarded)).toEqual([true, false, false]);

    // ③ 미탐 기록 — 검수가 통과시킨 글을 사람이 잡았다는 라벨.
    //    이것이 없으면 미탐률은 영원히 0으로 보인다 (검수 정확도의 유일한 미탐 경로)
    const review = await prisma.complianceReview.findFirst({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
    expect(review?.operatorVerdict).toBe('TAKEDOWN');
    expect(review?.operatorCategories).toContain('SOLICIT_CONTACT');
    // 근거 문장이 operatorEvidence 에 저장돼 IRIS 재학습 지역화의 근거가 된다 (2026-08-28)
    expect(review?.operatorEvidence).toContain('오픈채팅방에서 안내드립니다');

    // ④ **자동 통지는 한 통도 나가지 않는다** (2026-08-20 사용자 확정).
    //    확인 창에서 운영자가 신고자·리서처에게 직접 쓴 쪽지가 그 자리를 대신하므로,
    //    정형문까지 보내면 한 사건에 두 통이 가고 어느 쪽이 진짜 답인지 흐려진다.
    //    처분 자체(철회·환불·미탐 라벨·보상 표시)는 위에서 이미 확인했다
    const reporterNotes = await prisma.notification.findMany({
      where: { userId: { in: reporters }, type: 'ABUSE_REPORT_RESULT' },
    });
    expect(reporterNotes).toHaveLength(0);
    const takedownNote = await prisma.notification.findFirst({
      where: { userId: researcherUserId, type: 'COMPLIANCE_TAKEDOWN' },
    });
    expect(takedownNote).toBeNull();

    // ⑤ 확인 뒤에도 팔 수 없다 — 중단이 풀려서가 아니라 리포트 자체가 닫혔으므로
    const late = await prisma.user.create({
      data: { email: 'late@resolve.io', identityVerified: true },
    });
    await expect(purchaseReport(prisma, reportId, late.id, NOW)).rejects.toThrow();
  });

  it('확인된 미탐은 교사 질문지로 남아 재학습 논의 큐에 뜬다', async () => {
    // 신고로 잡힌 위반 = 검수가 놓친 것이라 재학습에서 가장 값진 라벨이다. 그전에는
    // 미탐 라벨만 쓰고 '재학습 논의 자료' 큐에는 안 떴다 — 검수 라우트는 판정마다
    // storeTeacherPackForReport 를 부르는데 신고 라우트만 빠져 있었다.
    // 라우트가 판정 커밋 뒤에 부르는 것과 같은 흐름을 재현한다.
    // 신선한 신고자 1명으로 단건 신고한다 — 공유 신고자 풀의 하루 한도(3건)를
    // 건드리면 뒤 시험이 깨진다(교사 질문지에는 중단·다수 신고가 필요 없다)
    const reportId = await publishTarget('교사 질문지 대상');
    const solo = await prisma.user.create({
      data: { email: 'teacherpack@resolve.io', identityVerified: true },
    });
    await createAbuseReport(
      prisma,
      {
        reporterId: solo.id,
        reportId,
        targetName: 't',
        category: 'OUTSIDE_CHANNEL',
        detail: '오픈채팅으로 유도하는 문구를 봤습니다',
      },
      NOW,
    );

    await resolveAbuseReportGroup(
      prisma,
      {
        reportId,
        operatorUserId: operatorId,
        decision: 'CONFIRMED',
        note: '본문에 오픈채팅 유도 문구 확인',
        categories: ['SOLICIT_CONTACT'],
      },
      NOW,
    );
    await storeTeacherPackForReport(prisma, reportId);

    const review = await prisma.complianceReview.findFirstOrThrow({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
    expect(review.operatorVerdict).toBe('TAKEDOWN');
    // 질문지가 저장돼야 큐(getTeacherAnswerPending)가 이 건을 자동으로 세운다
    expect(review.teacherPackText).not.toBeNull();

    const pending = await getTeacherAnswerPending(prisma);
    expect(pending.some((p) => p.reportId === reportId)).toBe(true);
  });

  it('이미 닫힌 리포트면 철회만 건너뛰고 신고 확인은 진행된다', async () => {
    const reportId = await publishTarget('이미 닫힌 리포트');
    await createAbuseReport(
      prisma,
      { reporterId: reporters[0], reportId, targetName: 't', category: 'SOLICIT', detail: '수익 보장 표현을 봤습니다' },
      NOW,
    );
    await prisma.report.update({ where: { id: reportId }, data: { status: 'CLOSED' } });

    const summary = await resolveAbuseReportGroup(
      prisma,
      { reportId, operatorUserId: operatorId, decision: 'CONFIRMED', note: '확인', categories: ['PROFIT_GUARANTEE'] },
      NOW,
    );
    expect(summary.takedown).toBeNull();
    expect(summary.takedownSkipped).toMatch(/이미/);
    const row = await prisma.abuseReport.findFirstOrThrow({ where: { reportId } });
    expect(row.status).toBe('CONFIRMED');

    // **철회는 못 했어도 "검수가 놓쳤다"는 남는다** (2026-08-21).
    // 예전에는 catch가 라벨 쓰기까지 삼켜, 판매가 끝난 뒤 드러난 위반 —
    // 검수가 가장 오래 놓친 건 — 이 미탐 집계에서 통째로 빠졌다.
    // `TAKEDOWN`이 아니라 `MISSED`인 것이 요점이다: 내린 적이 없으므로
    const review = await prisma.complianceReview.findFirstOrThrow({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
    expect(review.operatorVerdict).toBe('MISSED');
    expect(JSON.parse(review.operatorCategories ?? '[]')).toContain('PROFIT_GUARANTEE');
  });

  it('리포트가 사라진 건은 미탐으로 세지 않는다 — 우리 사고지 검수의 실수가 아니다', async () => {
    // 철회 실패 사유를 갈라 두지 않으면, 데이터 사고가 검수 성적을 깎는다.
    // 여기서는 카드가 없어 `DATA_ERROR`로 끊기고 라벨이 붙지 않아야 한다
    // 게시 파이프라인을 타지 않고 행을 직접 만든다 — 여기서 재는 것은 게시 규칙이
    // 아니라 **철회 실패 사유의 갈래**이고, 활성 카드 상한 같은 게시 규칙에 얽히면
    // 시험이 재려던 것과 다른 이유로 깨진다
    const { id: reportId } = await prisma.report.create({
      data: {
        researcherId,
        title: '카드 없는 리포트',
        summary: 's',
        content: 'c',
        priceKrw: 10_000,
        prepaymentRatio: 0,
        feeRateBp: 2000,
        status: 'PUBLISHED',
        publishedAt: PUBLISH_NOW,
      },
    });
    await createAbuseReport(
      prisma,
      {
        reporterId: reporters[1],
        reportId,
        targetName: 't',
        category: 'OTHER',
        detail: '본문이 약관을 위반한 것 같습니다',
      },
      NOW,
    );

    const summary = await resolveAbuseReportGroup(
      prisma,
      {
        reportId,
        operatorUserId: operatorId,
        decision: 'CONFIRMED',
        note: '확인',
        categories: ['RUMOR'],
      },
      NOW,
    );
    expect(summary.takedownSkipped).toMatch(/예측 카드/);

    const review = await prisma.complianceReview.findFirst({
      where: { reportId, operatorVerdict: { not: null } },
    });
    expect(review).toBeNull();
  });
});

describe('기각 = 전원 통지·무고 기록, 판매는 저절로 재개', () => {
  it('기각하면 리포트는 그대로 팔린다', async () => {
    const reportId = await publishTarget('기각 대상 리포트');
    await fileGroup(reportId);
    expect(await isAbuseSuspended(prisma, reportId)).toBe(true);

    const summary = await resolveAbuseReportGroup(
      prisma,
      { reportId, operatorUserId: operatorId, decision: 'REJECTED', note: '인용된 문구가 본문에 없음' },
      NOW,
    );
    expect(summary.resolved).toBe(ABUSE_SUSPEND_REPORTERS);
    expect(summary.rewarded).toBe(false);
    expect(summary.takedown).toBeNull();

    const rows = await prisma.abuseReport.findMany({ where: { reportId } });
    expect(rows.every((r) => r.status === 'REJECTED')).toBe(true);
    expect(await isAbuseSuspended(prisma, reportId)).toBe(false);

    const buyer = await prisma.user.create({
      data: { email: 'b2@resolve.io', identityVerified: true },
    });
    await expect(purchaseReport(prisma, reportId, buyer.id, NOW)).resolves.toBeTruthy();

    // **멈췄다는 말을 들은 사람은 열렸다는 말도 들어야 한다** (2026-08-20).
    // 중단 통지가 "확인 결과 문제가 없으면 다시 판매됩니다"라고 약속했는데,
    // 기각 통지는 신고자에게만 갔다 — 리서처는 자기 리포트를 눌러 봐야만 알았다
    const resumed = await prisma.notification.findFirst({
      where: { userId: researcherUserId, type: 'ABUSE_SALES_RESUMED' },
    });
    expect(resumed).not.toBeNull();
    // 제목·본문 모두 **고정 양식** (2026-08-20 사용자 확정). 운영자가 쓴 검토 사유는
    // 여기 실리지 않는다 — 기록(reviewNote)으로만 남는다
    expect(resumed!.title).toBe(ABUSE_RESUME_TITLE);
    expect(resumed!.body).toBe(ABUSE_RESUME_BODY);
    expect(resumed!.body).not.toContain('인용된 문구가 본문에 없음');

    // 신고자 셋은 다른 제목·다른 본문을 받는다 — 겪은 일이 다르기 때문이다
    // 앞 시험(확인)이 같은 사람들에게 이미 보낸 것이 있어 **제목으로 좁힌다** —
    // 확인 통지는 다른 제목을 쓰므로 이 필터가 곧 "기각 통지만"이다
    const toReporters = await prisma.notification.findMany({
      where: { userId: { in: reporters }, type: 'ABUSE_REPORT_RESULT', title: ABUSE_REPLY_TITLE },
    });
    expect(toReporters).toHaveLength(ABUSE_SUSPEND_REPORTERS);
    expect(toReporters.every((n) => n.body === ABUSE_REJECTED_REPORTER_BODY)).toBe(true);
  });

  it('멈춘 적 없는 리포트를 기각하면 리서처에게 알리지 않는다', async () => {
    // 문턱에 못 미친 신고는 리서처가 **존재 자체를 모른다.** 갚을 약속이 없는데
    // 알리면 없어도 될 불안과 보복의 실마리만 새로 만든다
    const reportId = await publishTarget('멈추지 않은 리포트');
    // 앞 시험들이 같은 날짜(NOW)로 신고를 쌓아 하루 한도(3건)를 이미 채웠다 —
    // 신고자를 새로 만든다
    const lone = await prisma.user.create({
      data: { email: 'lone@resolve.io', identityVerified: true },
    });
    await createAbuseReport(
      prisma,
      {
        reporterId: lone.id,
        reportId,
        targetName: 't',
        category: 'SOLICIT',
        detail: '수익 보장 표현을 봤습니다',
      },
      NOW,
    );
    expect(await isAbuseSuspended(prisma, reportId)).toBe(false);

    await resolveAbuseReportGroup(
      prisma,
      { reportId, operatorUserId: operatorId, decision: 'REJECTED', note: '근거 없음' },
      NOW,
    );

    const notes = await prisma.notification.findMany({
      where: { userId: researcherUserId, type: 'ABUSE_SALES_RESUMED' },
    });
    expect(notes.every((n) => !n.body.includes('멈추지 않은 리포트'))).toBe(true);
  });
});

describe('기각의 두 갈래 — 오신고 vs 지적 타당 (2026-08-27)', () => {
  it('지적 타당 기각은 무고로 안 세고, 경계 사례로 학습에 남긴다', async () => {
    // 게시 파이프라인을 타지 않는다(장기 카드 상한과 무관) — 필요한 것은 리포트 하나와
    // 그 리포트의 검수 기록(operatorVerdictWrites 가 갱신할 대상)뿐이다
    const report = await prisma.report.create({
      data: {
        researcherId,
        title: '지적 타당 기각 리포트',
        summary: 's',
        content: '본문에 애매한 표현이 하나 있다',
        priceKrw: 10_000,
        prepaymentRatio: 0,
        feeRateBp: 2000,
        status: 'PUBLISHED',
        publishedAt: PUBLISH_NOW,
      },
    });
    const reportId = report.id;
    await prisma.complianceReview.create({
      data: { reportId, decision: 'PASS', reviewer: 'rule', findingsJson: '[]' },
    });
    const reporter = await prisma.user.create({
      data: { email: 'valid-concern@resolve.io', identityVerified: true },
    });
    await createAbuseReport(
      prisma,
      {
        reporterId: reporter.id,
        reportId,
        targetName: 't',
        category: 'SOLICIT',
        detail: '수익 보장처럼 읽히는 표현이 있는 것 같습니다',
      },
      NOW,
    );

    await resolveAbuseReportGroup(
      prisma,
      {
        reportId,
        operatorUserId: operatorId,
        decision: 'REJECTED',
        note: '표현이 애매하나 위반까지는 아님',
        findingsValid: true,
      },
      NOW,
    );
    await storeTeacherPackForReport(prisma, reportId);

    // 기각(판매 재개)은 그대로 — 신고는 REJECTED
    const row = await prisma.abuseReport.findFirstOrThrow({ where: { reportId } });
    expect(row.status).toBe('REJECTED');

    // 검수 기록에 KEPT + findingsValid=true → 교사 질문지 생성(경계 사례 학습)
    const review = await prisma.complianceReview.findFirstOrThrow({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
    expect(review.operatorVerdict).toBe('KEPT');
    expect(review.aiFindingsValid).toBe(true);
    expect(review.teacherPackText).not.toBeNull();

    // **무고로 세지 않는다** — 이 신고자의 기각 이력이 0
    const listed = await getAbuseReports(prisma);
    const mine = listed.find((x) => x.reportId === reportId && x.reporterId === reporter.id);
    expect(mine?.reporterRejectedCount).toBe(0);
  });

  it('순수 오신고 기각은 무고 이력에 남고 학습에는 안 들어간다', async () => {
    const report = await prisma.report.create({
      data: {
        researcherId,
        title: '오신고 기각 리포트',
        summary: 's',
        content: '평범한 분석입니다',
        priceKrw: 10_000,
        prepaymentRatio: 0,
        feeRateBp: 2000,
        status: 'PUBLISHED',
        publishedAt: PUBLISH_NOW,
      },
    });
    const reportId = report.id;
    await prisma.complianceReview.create({
      data: { reportId, decision: 'PASS', reviewer: 'rule', findingsJson: '[]' },
    });
    const reporter = await prisma.user.create({
      data: { email: 'false-reporter@resolve.io', identityVerified: true },
    });
    await createAbuseReport(
      prisma,
      { reporterId: reporter.id, reportId, targetName: 't', category: 'OTHER', detail: '문제 없어 보이는데 그냥 신고합니다' },
      NOW,
    );

    await resolveAbuseReportGroup(
      prisma,
      { reportId, operatorUserId: operatorId, decision: 'REJECTED', note: '근거 없음', findingsValid: false },
      NOW,
    );

    // verdict 를 안 쓴다 — 모델은 옳게 통과시켰고 배울 게 없다
    const review = await prisma.complianceReview.findFirstOrThrow({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
    expect(review.operatorVerdict).toBeNull();

    // 무고 이력에 남는다
    const listed = await getAbuseReports(prisma);
    const mine = listed.find((x) => x.reportId === reportId && x.reporterId === reporter.id);
    expect(mine?.reporterRejectedCount).toBe(1);
  });
});

describe('판정이 끝난 리포트는 신고를 받지 않는다 (2026-08-27)', () => {
  it('판정된 카드의 리포트에 신고하면 거절한다 — 나올 처분이 없다', async () => {
    // 판정된 카드는 강제 철회가 불가능하고(정산 종료·환불 불가) 판매도 끝났다.
    // UI(리포트 버튼·/clean)도 감추지만, API 직접 호출을 막는 방어선은 createAbuseReport 다.
    //
    // 게시 파이프라인을 타지 않고 행을 직접 만든다 — 여기서 재는 것은 게시 규칙(장기 카드
    // 상한 등)이 아니라 **판정 완료 시 신고 게이트**이고, 필요한 것은 '판정된 카드가 달린
    // 리포트' 하나뿐이다
    const report = await prisma.report.create({
      data: {
        researcherId,
        title: '판정 완료 리포트',
        summary: 's',
        content: 'c',
        priceKrw: 10_000,
        prepaymentRatio: 0,
        feeRateBp: 2000,
        status: 'CLOSED',
        publishedAt: PUBLISH_NOW,
      },
    });
    const reportId = report.id;
    const card = await prisma.predictionCard.create({
      data: {
        reportId,
        assetClass: 'CRYPTO',
        ticker: 'KRW-AAA',
        assetName: 'KRW-AAA',
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 20,
        deadline: new Date('2026-12-01T00:00:00Z'),
      },
    });
    await prisma.judgment.create({ data: { predictionCardId: card.id, outcome: 'HIT' } });

    const reporter = await prisma.user.create({
      data: { email: 'judged-reporter@resolve.io', identityVerified: true },
    });
    await expect(
      createAbuseReport(
        prisma,
        {
          reporterId: reporter.id,
          reportId,
          targetName: 't',
          category: 'SOLICIT',
          detail: '수익 보장 표현을 봤습니다',
        },
        NOW,
      ),
    ).rejects.toThrow(/판정이 완료/);

    // 신고 행이 실제로 만들어지지 않았다
    expect(await prisma.abuseReport.count({ where: { reportId } })).toBe(0);
  });
});
