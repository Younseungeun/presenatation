import type { PrismaClient } from '@prisma/client';

// 무료 시황·증시 리포트 — 예측 카드가 없는 글.
//
// 설계 근거: 기획 §2.1은 "모든 **유료** 리포트에는 예측 카드가 필수"라고 규정한다.
// 무료 글은 판매물이 아니므로 카드를 붙이지 않고, 그래서 판정·점수·에스크로·정산·수수료와
// 완전히 분리된다. 유료 게시 경로(createDraftReport/publishReport)는 건드리지 않는다 —
// 그쪽은 돈과 판정 불변식이 걸려 있어 손대면 위험하다.
//
// 역할: 일반 투자자 유입용 무료 콘텐츠. 여기서 리서처를 알게 되면 유료 예측 카드로 이어진다.

export const FREE_REPORT_PRICE_KRW = 0;

export class FreeReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreeReportError';
  }
}

export interface CreateFreeReportInput {
  researcherId: string;
  title: string;
  summary: string;
  content: string;
}

/** 무료 글은 초안 단계 없이 바로 게시된다(잠글 예측이 없어 초안이 의미가 없다) */
export async function createFreeReport(
  prisma: PrismaClient,
  input: CreateFreeReportInput,
  now = new Date(),
) {
  const title = input.title.trim();
  const summary = input.summary.trim();
  const content = input.content.trim();

  if (title.length === 0 || title.length > 200) {
    throw new FreeReportError('제목은 1~200자여야 합니다');
  }
  if (summary.length === 0 || summary.length > 300) {
    throw new FreeReportError('요약은 1~300자여야 합니다');
  }
  if (content.length === 0) {
    throw new FreeReportError('본문을 입력해주세요');
  }

  await prisma.researcherProfile.findUniqueOrThrow({ where: { id: input.researcherId } });

  return prisma.report.create({
    data: {
      researcherId: input.researcherId,
      title,
      summary,
      content,
      priceKrw: FREE_REPORT_PRICE_KRW,
      prepaymentRatio: 0,
      feeRateBp: 0, // 판매액이 없으므로 수수료도 없다
      status: 'PUBLISHED',
      publishedAt: now,
      // predictionCard 없음 → 판정 배치·점수 집계·정산 대상이 아니다
    },
  });
}

export interface FreeReportSummary {
  reportId: string;
  title: string;
  summary: string;
  researcherId: string;
  researcherName: string;
  tier: string;
  careerBadge: string | null;
  publishedAt: Date | null;
}

/** 무료 리포트 목록 — 최신순. 홈의 "무료로 열람 가능한 시황·증시 리포트" 섹션에서 쓴다 */
export async function getFreeReports(
  prisma: PrismaClient,
  limit = 5,
): Promise<FreeReportSummary[]> {
  const reports = await prisma.report.findMany({
    where: { status: 'PUBLISHED', priceKrw: FREE_REPORT_PRICE_KRW, predictionCard: { is: null } },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    include: { researcher: { include: { user: { select: { penName: true, email: true } } } } },
  });

  // 판매 중 카드 수는 여기서 세지 않는다 — 목록은 읽을 글을 고르는 자리이고,
  // 판매로 가는 길은 본문 하단의 리서처 명함(getResearcherCallout)이 맡는다
  return reports.map((r) => ({
    reportId: r.id,
    title: r.title,
    summary: r.summary,
    researcherId: r.researcherId,
    researcherName: r.researcher.user.penName ?? r.researcher.user.email,
    tier: r.researcher.tier,
    careerBadge: r.researcher.careerBadge,
    publishedAt: r.publishedAt,
  }));
}

/** 무료 글인지 — 결제·장바구니를 막고 본문을 바로 여는 기준 */
export function isFreeReport(report: { priceKrw: number }): boolean {
  return report.priceKrw === FREE_REPORT_PRICE_KRW;
}
