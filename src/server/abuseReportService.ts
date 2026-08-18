import type { PrismaClient } from '@prisma/client';

// 클린 리서치 신고 제도 — 1:1 상담 유도·투자 권유 등 유사투자자문업 범위를 넘는 행위를
// 이용자가 신고하면, 운영자 검토로 확인된 신고에 한해 선착순으로 보상 대상이 된다.
//
// ⚠ **지급 수단은 아직 없다** (2026-08-18 확인). `rewarded`는 "보상 대상"까지만 뜻하고,
// 실제 지급은 운영자가 개별로 안내한다. 원래 설계는 리포트 구매 쿠폰인데 쿠폰 발행·사용을
// 만들지 않았고, 그런데도 문구는 "쿠폰이 지급될 예정"이라고 약속하고 있었다 — 지킬 수
// 없는 말이라 문구를 걷어냈다(알림·/clean·배너·이 화면).
// 쿠폰을 나중에 만들 때 걸리는 것: **할인은 결제 금액을 바꾼다.** 쿠폰으로 깎아 산
// 리포트가 실패 판정되면 환불액이 얼마인지, 리서처 정산이 정가 기준인지 할인가 기준인지가
// 정산의 금액 보존 규칙과 충돌한다. 그 설계가 끝나기 전에는 만들지 않는다.
//  · 보상은 반드시 운영자 검토(CONFIRMED) 후 — 오신고에 보상이 나가는 일이 없게
//  · 무고 방어: 하루 신고 한도 + 기각 사유 기록(반복 무고 제재 근거)
//  · (설계 근거 보존) 쿠폰은 무상 지급 할인권 — 대가 없이 발행되어 선불전자지급수단
//    규제 대상이 아니다. 이 판단은 유효하고, 만들 때 그대로 쓴다
//    (자체 크레딧·포인트를 만들지 않는 플랫폼 원칙과 정합)

export const ABUSE_CATEGORIES = ['ONE_ON_ONE', 'SOLICIT', 'OUTSIDE_CHANNEL', 'OTHER'] as const;
export type AbuseCategory = (typeof ABUSE_CATEGORIES)[number];

export const ABUSE_CATEGORY_LABEL: Record<AbuseCategory, string> = {
  ONE_ON_ONE: '1:1 상담·개별 연락 유도',
  SOLICIT: '수익 보장·투자 권유 표현',
  OUTSIDE_CHANNEL: '외부 채널(리딩방·오픈채팅 등) 유인',
  OTHER: '기타 이용약관·법령 위반 의심',
};

/** 보상 선착순 쿼터 — 확인된 신고 기준. 소진 후에도 신고는 받되 보상 없이 처리 */
export const REWARD_QUOTA = 100;
/** 무고성 대량 신고 1차 방어 — 1인당 하루 신고 한도 */
export const DAILY_REPORT_LIMIT = 3;

export class AbuseReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbuseReportError';
  }
}

export interface CreateAbuseReportInput {
  reporterId: string;
  targetName: string;
  category: AbuseCategory;
  detail: string;
  reportId?: string;
}

export async function createAbuseReport(
  prisma: PrismaClient,
  input: CreateAbuseReportInput,
  now = new Date(),
) {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = await prisma.abuseReport.count({
    where: { reporterId: input.reporterId, createdAt: { gte: startOfDay } },
  });
  if (todayCount >= DAILY_REPORT_LIMIT) {
    throw new AbuseReportError(
      `신고는 하루 ${DAILY_REPORT_LIMIT}건까지 접수할 수 있습니다. 내일 다시 시도해 주세요.`,
    );
  }

  return prisma.abuseReport.create({
    data: {
      reporterId: input.reporterId,
      targetName: input.targetName.trim(),
      category: input.category,
      detail: input.detail.trim(),
      reportId: input.reportId ?? null,
    },
  });
}

/** 지금까지 보상이 확정된 건수 — 선착순 잔여 계산용 */
export async function rewardedCount(prisma: PrismaClient): Promise<number> {
  return prisma.abuseReport.count({ where: { rewarded: true } });
}

export interface AbuseReportRow {
  id: string;
  reporterName: string;
  targetName: string;
  category: string;
  detail: string;
  status: string;
  rewarded: boolean;
  reviewNote: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  /** 같은 신고자의 기각(무고) 누적 — 반복 무고 제재 판단 보조 */
  reporterRejectedCount: number;
}

/** 운영자 검토 목록 — 대기 건 먼저, 최신순 */
export async function getAbuseReports(prisma: PrismaClient): Promise<AbuseReportRow[]> {
  const rows = await prisma.abuseReport.findMany({ orderBy: { createdAt: 'desc' } });
  const reporterIds = [...new Set(rows.map((r) => r.reporterId))];
  const users = await prisma.user.findMany({
    where: { id: { in: reporterIds } },
    select: { id: true, penName: true, email: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.penName ?? u.email]));
  const rejectedOf = new Map<string, number>();
  for (const r of rows) {
    if (r.status === 'REJECTED') {
      rejectedOf.set(r.reporterId, (rejectedOf.get(r.reporterId) ?? 0) + 1);
    }
  }
  return rows
    .map((r) => ({
      id: r.id,
      reporterName: nameOf.get(r.reporterId) ?? r.reporterId,
      targetName: r.targetName,
      category: r.category,
      detail: r.detail,
      status: r.status,
      rewarded: r.rewarded,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      reporterRejectedCount: rejectedOf.get(r.reporterId) ?? 0,
    }))
    .sort((a, b) =>
      a.status === b.status
        ? b.createdAt.getTime() - a.createdAt.getTime()
        : a.status === 'PENDING'
          ? -1
          : b.status === 'PENDING'
            ? 1
            : 0,
    );
}

export interface ReviewAbuseReportInput {
  id: string;
  operatorUserId: string;
  decision: 'CONFIRMED' | 'REJECTED';
  note: string;
}

/**
 * 운영자 검토 — 확인이면 선착순 쿼터 안에서 **보상 대상**으로 표시하고 신고자에게 알림.
 * (표시까지가 전부다 — 지급 수단은 없고 운영자가 개별로 안내한다. 파일 머리 주석 참고)
 * 기각이면 사유를 기록해 반복 무고 제재의 근거로 남긴다.
 */
export async function reviewAbuseReport(
  prisma: PrismaClient,
  input: ReviewAbuseReportInput,
  now = new Date(),
) {
  const report = await prisma.abuseReport.findUnique({ where: { id: input.id } });
  if (!report) throw new AbuseReportError('신고를 찾을 수 없습니다');
  if (report.status !== 'PENDING') throw new AbuseReportError('이미 검토가 끝난 신고입니다');

  const rewarded =
    input.decision === 'CONFIRMED' && (await rewardedCount(prisma)) < REWARD_QUOTA;

  const [updated] = await prisma.$transaction([
    prisma.abuseReport.update({
      where: { id: input.id, status: 'PENDING' }, // 동시 검토 대비 원자적 전이
      data: {
        status: input.decision,
        rewarded,
        reviewedAt: now,
        reviewerId: input.operatorUserId,
        reviewNote: input.note.trim(),
      },
    }),
    prisma.notification.create({
      data: {
        userId: report.reporterId,
        type: 'ABUSE_REPORT_RESULT',
        title:
          input.decision === 'CONFIRMED' ? '신고가 확인되었습니다' : '신고 검토 결과 안내',
        body:
          input.decision === 'CONFIRMED'
            ? rewarded
              ? // **지급 수단을 특정하지 않는다** (2026-08-18). 예전 문구는 "쿠폰이 지급될
                // 예정입니다"였는데 쿠폰 발행·사용 기능이 없다 — 지킬 수 없는 약속이었다.
                // 보상 자체는 실제로 한다(운영자가 개별 안내). 수단이 생기면 문구를 되돌린다
                '신고하신 내용이 확인되어 해당 리포트에 조치했습니다. 보상 대상에 포함되었고, 지급 방법은 개별로 안내드리겠습니다. 클린 리서치에 함께해 주셔서 감사합니다.'
              : '신고하신 내용이 확인되어 해당 리포트에 조치했습니다. 보상은 선착순 수량이 마감되어 대상이 아니지만, 신고는 조치에 그대로 반영되었습니다.'
            : '신고하신 내용은 검토 결과 위반으로 확인되지 않았습니다. 고의적인 허위 신고가 반복되면 이용이 제한될 수 있습니다.',
        link: '/clean',
      },
    }),
  ]);
  return { ...updated, rewarded };
}
