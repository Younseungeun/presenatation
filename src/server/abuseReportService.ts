import type { PrismaClient } from '@prisma/client';
import { ABUSE_SUSPEND_REPORTERS, suspendsOnAbuseReports } from '@/domain/abuseSuspension';
import { TIER_NAME, type Tier } from '@/domain/constants';
import {
  ABUSE_REJECTED_REPORTER_BODY,
  ABUSE_REPLY_TITLE,
  ABUSE_RESUME_BODY,
  ABUSE_RESUME_TITLE,
} from '@/domain/notice';
import { displayName } from '@/lib/displayName';
import { notifyOperators } from './opsAlert';

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

/**
 * 같은 유형을 **신고자의 말로** 옮긴 것 — "이 사람은 무엇을 봤다고 말하는가".
 *
 * 위 LABEL은 고르는 자리(선택 목록·칩)의 이름표라 명사로 끝난다. 그런데 신고자
 * 한 사람 한 사람의 줄에서는 이름표가 아니라 **그 사람의 주장**이 필요하다 —
 * 세 사람이 각각 무엇을 걸고 신고했는지가 이 화면에서 판단의 재료이기 때문이다.
 * (2026-08-20 사용자 지시)
 */
export const ABUSE_CATEGORY_CLAIM: Record<AbuseCategory, string> = {
  ONE_ON_ONE: '1:1 개별 상담을 유도했어요',
  SOLICIT: '수익 보장·투자 권유 표현을 썼어요',
  OUTSIDE_CHANNEL: '리딩방·오픈채팅 등 외부 채널로 유인했어요',
  OTHER: '이용약관·법령 위반이 의심돼요',
};

/**
 * 칩(버튼)에 얹는 **짧은 이름표** — LABEL을 한 줄 칩 안에 넣으면 넘친다.
 *
 * 신고 화면에서 유형을 드롭다운이 아니라 4개 칩으로 고르게 하면서 필요해졌다
 * (2026-08-27 창업자 지시: 상단 '신고 대상 행위' 설명과 아래 유형 선택이 같은 4가지인데
 * 화면에서 끊겨 있어, 고르는 자리를 칩으로 만들어 설명과 선택을 하나로 잇는다).
 * LABEL과 뜻은 같고 길이만 줄인 것이라 순서·키가 어긋나면 안 된다.
 */
export const ABUSE_CATEGORY_SHORT: Record<AbuseCategory, string> = {
  ONE_ON_ONE: '1:1 상담 유도',
  SOLICIT: '수익 보장·권유',
  OUTSIDE_CHANNEL: '외부 채널 유인',
  OTHER: '기타 위반',
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

/** 신고자가 짚은 한 부분 — 본문 문장 + 유형 (2026-08-27) */
export interface AbuseFinding {
  quote: string;
  category: AbuseCategory;
}

export interface CreateAbuseReportInput {
  reporterId: string;
  targetName: string;
  category: AbuseCategory;
  detail: string;
  reportId?: string;
  /** 문장별 지적 — 본문을 산 신고자만. 운영자 화면이 이것으로 카드를 그린다 */
  findings?: AbuseFinding[];
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

  // **판정이 끝난 리포트는 신고를 받지 않는다** (2026-08-27 창업자 지시).
  //
  // 판정된 카드는 강제 철회가 구조적으로 불가능하고(정산이 끝나 환불도 못 하며,
  // forceWithdrawReport 가 ALREADY_CLOSED 로 막는다) 판매도 이미 끝났다 — 신고해도
  // 나올 처분이 없다. UI(리포트 신고 버튼·/clean)도 감추지만, API 직접 호출을 막는
  // 권위 있는 방어선은 여기다. reportId 없는 이름 신고(자유 입력)는 이 게이트를 지나지 않는다
  if (input.reportId) {
    const target = await prisma.report.findUnique({
      where: { id: input.reportId },
      select: { predictionCard: { select: { judgment: { select: { id: true } } } } },
    });
    if (target?.predictionCard?.judgment) {
      throw new AbuseReportError('이미 판정이 완료된 리포트는 신고할 수 없습니다.');
    }
  }

  // **같은 사람이 같은 리포트를 두 번 신고할 수 없다.** 중단 문턱이 "서로 다른 신고자
  // 수"인데 한 사람이 3번 눌러 3이 되면 문턱이 아무것도 막지 않는다. 하루 3건 한도가
  // 있어도 그 한도 자체가 정확히 3이라 혼자서 닿는다.
  // DB의 @@unique([reporterId, reportId])가 최종 방어선이고(동시 요청), 여기서는
  // 사람에게 읽히는 말로 먼저 답한다
  if (input.reportId) {
    const mine = await prisma.abuseReport.findFirst({
      where: { reporterId: input.reporterId, reportId: input.reportId },
      select: { id: true },
    });
    if (mine) {
      throw new AbuseReportError(
        '이미 이 리포트를 신고하셨습니다. 검토 결과는 알림으로 알려드립니다.',
      );
    }
  }

  // 문장별 지적 — 빈 인용은 버리고, 있으면 직렬화해 저장한다
  const findings = (input.findings ?? [])
    .map((f) => ({ quote: f.quote.trim(), category: f.category }))
    .filter((f) => f.quote.length > 0);

  const created = await prisma.abuseReport.create({
    data: {
      reporterId: input.reporterId,
      targetName: input.targetName.trim(),
      category: input.category,
      detail: input.detail.trim(),
      reportId: input.reportId ?? null,
      findingsJson: findings.length ? JSON.stringify(findings) : null,
    },
  });

  // 이번 신고로 문턱을 **넘는 순간에만** 리서처에게 알린다. 넘은 뒤의 신고마다 알리면
  // 같은 사실이 반복해 오고, 반복해 오는 알림은 곧 안 읽히는 알림이 된다
  if (input.reportId) {
    await notifyIfNewlySuspended(prisma, input.reportId);
  }
  return created;
}

/**
 * 이 리포트에 이미 접수된 신고가 있는지 — **개수는 돌려주지 않는다.**
 *
 * 개수를 화면에 띄우면 누구나 신고 버튼을 눌러 **자기 진도를 잴 수 있다.** 문턱이 3인
 * 것을 아는 담합자는 "2건 접수됨"을 보고 정확히 한 명만 더 부른다 — 고지가 공격의
 * 계기판이 되는 셈이다. 그래서 밖으로 나가는 것은 **있다/없다** 뿐이다.
 *
 * `rewardEligible`은 "지금 신고하면 보상 대상이 될 수 있나" — 리포트별 첫 신고자만이라
 * 이미 신고가 있으면 false다. 이 값을 굳이 먼저 알려 주는 이유는 두 번째 신고자에게
 * **정직하기 위해서**다: 보상은 없지만 그 신고는 판단에 그대로 들어간다.
 */
export async function getReportAbuseNotice(
  prisma: PrismaClient,
  reportId: string,
  viewerId: string,
): Promise<{
  alreadyReported: boolean;
  byViewer: boolean;
  rewardEligible: boolean;
}> {
  const rows = await prisma.abuseReport.findMany({
    where: { reportId },
    select: { reporterId: true },
  });
  return {
    alreadyReported: rows.length > 0,
    byViewer: rows.some((r) => r.reporterId === viewerId),
    rewardEligible: rows.length === 0,
  };
}

/**
 * 지금 신고 누적으로 판매가 멈춰 있는 리포트들.
 *
 * 목록 화면이 카드 수만큼 질의하지 않도록 **여러 id를 한 번에** 받는다
 * (구매 관문의 단건 경로는 아래 `isAbuseSuspended`).
 */
export async function abuseSuspendedReportIds(
  prisma: PrismaClient,
  reportIds: string[],
): Promise<Set<string>> {
  if (reportIds.length === 0) return new Set();
  const rows = await prisma.abuseReport.findMany({
    where: { reportId: { in: reportIds }, status: 'PENDING' },
    select: { reportId: true, reporterId: true },
  });
  const byReport = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.reportId) continue;
    const set = byReport.get(r.reportId) ?? new Set<string>();
    set.add(r.reporterId);
    byReport.set(r.reportId, set);
  }
  const out = new Set<string>();
  for (const [id, reporters] of byReport) {
    if (suspendsOnAbuseReports(reporters.size)) out.add(id);
  }
  return out;
}

/** 구매 관문에 넘길 값 — `disciplineCapFor`와 같은 자리, 같은 모양 */
export async function isAbuseSuspended(prisma: PrismaClient, reportId: string): Promise<boolean> {
  return (await abuseSuspendedReportIds(prisma, [reportId])).has(reportId);
}

/**
 * 문턱을 막 넘었으면 리서처에게 알린다.
 *
 * **안 알리면 이 장치는 보이지 않는 무기가 된다** — 판매가 멈췄는데 본인만 모르는
 * 상태가 며칠 간다. 숨기지 않고 크게 안내하는 것이 정산 동결에서 세운 원칙이고
 * 여기도 같다. 다만 신고자가 누구인지는 말하지 않는다(보복의 통로가 된다).
 */
async function notifyIfNewlySuspended(prisma: PrismaClient, reportId: string) {
  const reporters = await prisma.abuseReport.findMany({
    where: { reportId, status: 'PENDING' },
    select: { reporterId: true },
  });
  const distinct = new Set(reporters.map((r) => r.reporterId)).size;
  // **막 넘은 순간에만.** 넘은 뒤에도 신고는 계속 들어오므로 `>=`로 두면 매번 울린다
  if (distinct !== ABUSE_SUSPEND_REPORTERS) return;

  const report = await prisma.report.findUnique({
    where: { id: reportId },
    select: { title: true, researcher: { select: { userId: true } } },
  });
  if (!report) return;

  await prisma.notification.create({
    data: {
      userId: report.researcher.userId,
      type: 'ABUSE_SALES_SUSPENDED',
      title: '리포트 판매가 일시 중단되었습니다',
      body: `「${report.title}」에 여러 건의 신고가 접수되어 확인이 끝날 때까지 판매를 멈췄습니다. 확인 결과 문제가 없으면 다시 판매됩니다. 이미 구매한 분들의 열람과 판정에는 영향이 없습니다.`,
      link: `/report/${reportId}`,
    },
  });

  // **운영자에게도 앱 밖으로 알린다 (2026-08-19).**
  //
  // 이 중단은 사람 없이 기계가 건 것이고, **기계가 건 것은 사람이 풀어야 끝난다** —
  // 검토 큐에 신고가 쌓이는 것을 아침에 발견하면 그때까지 리서처는 이유도 모른 채
  // 하루치 판매 기간을 잃는다(판매 기간은 복구 장치가 없다).
  // 즉 이 알림은 리서처를 위한 것이지 우리를 위한 것이 아니다: **자동 중단을 만든
  // 대가로 우리가 지는 의무**가 "빨리 본다"이고, 그 의무를 지키게 하는 장치가 이 한 줄이다.
  await notifyOperators(prisma, {
    title: '신고 누적 — 리포트 판매가 자동 중단됐습니다',
    body: `「${report.title}」에 서로 다른 신고자 ${ABUSE_SUSPEND_REPORTERS}명이 모여 판매를 멈췄습니다. 사람이 아직 안 본 상태라 멈춘 것이니 검토해 주세요 — 위반이면 강제 철회, 아니면 기각하면 즉시 다시 팔립니다.`,
    link: '/admin/abuse-reports',
    type: 'ABUSE_SALES_SUSPENDED',
    dedupeKey: `abuse-suspended:${reportId}`,
  });
}

/**
 * 기각으로 판매가 다시 열렸음을 리서처에게 알린다 (2026-08-20 사용자 지적).
 *
 * **제목도 본문도 고정 양식이다** (2026-08-20 사용자 확정 — domain/notice의
 * ABUSE_RESUME_TITLE·ABUSE_RESUME_BODY). 기각의 결과는 하나뿐이라 매번 새로 지을
 * 사연이 없고, 운영자가 쓴 검토 사유는 남에게 읽히려고 쓴 글이 아니다.
 *
 * **약속을 갚는 알림이다.** 바로 위 중단 통지가 리서처에게 이렇게 말한다 —
 * "확인 결과 문제가 없으면 다시 판매됩니다." 그런데 기각 경로에는 통지가
 * 신고자에게만 있었다. 즉 리서처는 **멈췄다는 말만 듣고 끝**이었고, 다시 열린 것을
 * 알려면 자기 리포트를 눌러 보는 수밖에 없었다. 판매가 멈춘 사람은 그 화면을
 * 몇 번이고 다시 눌러 보게 되는데, 그 시간 전부가 우리가 말해 주지 않아서 생긴 것이다.
 *
 * **멈춘 적 없으면 보내지 않는다.** 신고가 문턱에 못 미쳐 판매가 계속되고 있었다면
 * 리서처는 신고 사실 자체를 모른다. 거기에 "신고가 있었지만 기각됐다"고 알리는 것은
 * 갚을 약속이 없는데 **없어도 될 불안과 보복의 실마리**를 새로 만드는 일이다.
 *
 * 잃은 판매 기간을 함께 적는 이유: 판매 창은 게시 시각 기준으로 정해져 멈춘 만큼
 * 되돌려 주지 못한다(salesWindow). 우리에게 불리한 사실이라 더더욱 우리가 먼저 적는다.
 */
export async function notifySalesResumedAfterRejection(
  prisma: PrismaClient,
  reportId: string,
  now = new Date(),
) {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    select: { researcher: { select: { userId: true } } },
  });
  if (!report) return;

  await prisma.notification.create({
    data: {
      userId: report.researcher.userId,
      type: 'ABUSE_SALES_RESUMED',
      title: ABUSE_RESUME_TITLE,
      body: ABUSE_RESUME_BODY,
      link: `/report/${reportId}`,
      createdAt: now,
    },
  });
}

/**
 * 관리자 홈이 쓰는 요약 — 대기 건수와 **판매가 멈춰 있는 리포트 수**.
 *
 * 후자가 이 함수를 만든 이유다. 신고 대기 건수만 세면 "5건 밀림"과 "5건 밀렸는데
 * 그중 둘은 판매가 이미 멈췄음"이 같은 숫자로 보인다 — 두 번째는 리서처가 지금
 * 이 순간 복구되지 않는 판매 기간을 잃고 있다는 뜻이라 성격이 다르다.
 */
export async function getAbuseQueueSummary(
  prisma: PrismaClient,
): Promise<{ pending: number; suspendedReports: number }> {
  const rows = await prisma.abuseReport.findMany({
    where: { status: 'PENDING' },
    select: { id: true, reportId: true },
  });
  const ids = [...new Set(rows.map((r) => r.reportId).filter((v): v is string => !!v))];
  const suspended = await abuseSuspendedReportIds(prisma, ids);
  return { pending: rows.length, suspendedReports: suspended.size };
}

/** 지금까지 보상이 확정된 건수 — 선착순 잔여 계산용 */
export async function rewardedCount(prisma: PrismaClient): Promise<number> {
  return prisma.abuseReport.count({ where: { rewarded: true } });
}

export interface AbuseReportRow {
  id: string;
  /** 누구에게 보낼지 — 개별 쪽지(DirectMessage)가 이 값을 쓴다 */
  reporterId: string;
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
  /** 신고 대상 리포트 — 리포트 화면에서 신고한 건만 있다 */
  reportId: string | null;
  /** 그 리포트의 제목 (지금은 지워졌을 수도 있어 null 허용) */
  reportTitle: string | null;
  /** 이 리포트가 신고 누적으로 **지금 판매가 멈춰 있는지** */
  suspended: boolean;
  /** 보상을 개별로 안내한 시각 — 없으면 아직 '안내 대기' */
  rewardNoticedAt: Date | null;
  /** 누가 쓴 글인가 — 줄에서 곧장 읽혀야 한다 (시안: `칩워처 · 마스터 · 판매 14건`) */
  researcherName: string | null;
  /** 그 사람에게 말을 걸 때 쓴다 — 철회 확인 창의 리서처 쪽지(DirectMessage) */
  researcherUserId: string | null;
  tierLabel: string | null;
  salesCount: number | null;
}

/**
 * 운영자 검토 목록 — 대기 건 먼저, 최신순.
 *
 * **`reportId`·`suspended`를 함께 싣는다 (2026-08-19).** 그전에는 행마다 자유 입력
 * `targetName`만 있어서, 한 리포트에 신고가 셋 들어오면 화면에 카드 세 장이 따로 뜨고
 * **운영자는 그것이 같은 건인 줄 몰랐다** — 같은 위반을 세 번 따로 읽고 세 번 따로
 * 판단했다. 무엇보다 그 셋 때문에 **판매가 이미 멈춰 있다는 사실이 어디에도 없었다.**
 */
export async function getAbuseReports(prisma: PrismaClient): Promise<AbuseReportRow[]> {
  const rows = await prisma.abuseReport.findMany({
    orderBy: { createdAt: 'desc' },
  });
  const reporterIds = [...new Set(rows.map((r) => r.reporterId))];
  const users = await prisma.user.findMany({
    where: { id: { in: reporterIds } },
    select: { id: true, penName: true, email: true },
  });
  /**
   * **신고자는 앱에서 쓰는 이름(필명)으로 적는다** (2026-08-20 사용자 지시).
   *
   * 전에는 `penName ?? email`이었는데, `email` 칸은 본인 인증 CI 해시 앞 24글자로
   * 채운 자리표시자라(`authService`, 도메인 `identity.local`은 존재하지 않는다)
   * 필명 없는 이용자에게는 `9a203fd4…@identity.local`이 떴다 — 아무도 식별하지 못하고
   * 연락도 안 되는 문자열이다.
   *
   * 실명(User.realNameEnc)을 쓰지 않는 이유: **운영자가 이 사람에게 말을 걸 때 부를
   * 이름이 앱에서 쓰는 이름**이어야 한다. 실명으로 부르면 이용자는 자기가 그 이름을
   * 알려준 적 없는 화면에서 그 이름을 듣게 된다. 실명 대조가 필요한 자리는 따로 있다
   * (계좌 예금주 대조 — securityScreen).
   *
   * MY 화면과 **같은 함수**를 쓴다(lib/displayName) — 표현을 옮겨 적으면 언젠가 한쪽만
   * 고쳐지고, 그때 운영자가 쪽지에 쓴 이름을 받는 사람이 못 알아본다.
   */
  const nameOf = new Map(users.map((u) => [u.id, displayName(u)]));

  const reportIds = [...new Set(rows.map((r) => r.reportId).filter((v): v is string => !!v))];
  // **줄에 실을 것까지 함께 받는다** — 누가 쓴 글이고 얼마나 팔렸는지는 펼치기 전에
  // 알아야 급함이 잡힌다(많이 팔린 글일수록 환불이 크다). 리포트 수만큼이 아니라
  // 질의 한 번이다
  const targets = await prisma.report.findMany({
    where: { id: { in: reportIds } },
    select: {
      id: true,
      title: true,
      researcher: {
        select: {
          tier: true,
          user: { select: { id: true, penName: true, email: true } },
        },
      },
      _count: { select: { purchases: true } },
    },
  });
  const titleOf = new Map(targets.map((t) => [t.id, t.title]));
  const metaOf = new Map(
    targets.map((t) => [
      t.id,
      {
        researcherName: t.researcher.user.penName ?? t.researcher.user.email,
        researcherUserId: t.researcher.user.id,
        tierLabel: TIER_NAME[t.researcher.tier as Tier] ?? t.researcher.tier,
        salesCount: t._count.purchases,
      },
    ]),
  );
  const suspended = await abuseSuspendedReportIds(prisma, reportIds);

  // **지적이 타당했던 기각은 무고가 아니다** (2026-08-27 창업자 지시). 운영자가 "위반은
  // 아니지만 지적은 타당했다"로 기각하면 검수 기록에 KEPT + findingsValid=true 가 남는다.
  // 그 리포트의 REJECTED 신고는 성실한 지적이라 무고 이력(reporterRejectedCount)에서 뺀다 —
  // 순수 오신고만 반복 무고 판단에 들어가야 한다
  const validConcernRows = reportIds.length
    ? await prisma.complianceReview.findMany({
        where: { reportId: { in: reportIds }, operatorVerdict: 'KEPT', aiFindingsValid: true },
        select: { reportId: true },
      })
    : [];
  const validConcernReports = new Set(validConcernRows.map((r) => r.reportId));

  const rejectedOf = new Map<string, number>();
  for (const r of rows) {
    // 지적이 타당했던 기각은 무고로 세지 않는다
    if (r.status === 'REJECTED' && !(r.reportId && validConcernReports.has(r.reportId))) {
      rejectedOf.set(r.reporterId, (rejectedOf.get(r.reporterId) ?? 0) + 1);
    }
  }
  return rows
    .map((r) => ({
      id: r.id,
      reporterId: r.reporterId,
      reporterName: nameOf.get(r.reporterId) ?? r.reporterId,
      targetName: r.targetName,
      category: r.category,
      detail: r.detail,
      status: r.status,
      rewarded: r.rewarded,
      rewardNoticedAt: r.rewardNoticedAt,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      reporterRejectedCount: rejectedOf.get(r.reporterId) ?? 0,
      reportId: r.reportId,
      reportTitle: r.reportId ? (titleOf.get(r.reportId) ?? null) : null,
      suspended: r.reportId ? suspended.has(r.reportId) : false,
      researcherName: r.reportId ? (metaOf.get(r.reportId)?.researcherName ?? null) : null,
      researcherUserId: r.reportId ? (metaOf.get(r.reportId)?.researcherUserId ?? null) : null,
      tierLabel: r.reportId ? (metaOf.get(r.reportId)?.tierLabel ?? null) : null,
      salesCount: r.reportId ? (metaOf.get(r.reportId)?.salesCount ?? null) : null,
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

/**
 * 한 리포트에 모인 신고를 **한 덩어리로** 묶은 것 — 운영자 화면이 쓰는 단위.
 *
 * 판단의 단위가 신고 한 건이 아니라 **리포트 하나**이기 때문이다: 운영자가 답할 질문은
 * "이 신고가 맞나"가 아니라 "이 리포트를 내려야 하나"이고, 그 판단의 재료는 모인 신고
 * 전부다. 셋을 따로 늘어놓으면 같은 본문을 세 번 읽으면서도 **몇 사람이 가리키는지는
 * 끝내 안 보인다** — 정작 그 수가 가장 강한 신호인데.
 */
export interface AbuseReportGroup {
  reportId: string | null;
  title: string;
  /** 서로 다른 신고자 수 — 판매 중단 문턱과 같은 잣대 */
  reporterCount: number;
  suspended: boolean;
  reports: AbuseReportRow[];
}

export function groupAbuseReports(rows: AbuseReportRow[]): AbuseReportGroup[] {
  const groups = new Map<string, AbuseReportGroup>();
  for (const r of rows) {
    // 리포트가 안 붙은 옛 신고(자유 입력)는 묶을 수 없다 — 각자 한 덩어리로 둔다
    const key = r.reportId ?? `free:${r.id}`;
    const g = groups.get(key) ?? {
      reportId: r.reportId,
      title: r.reportTitle ?? r.targetName,
      reporterCount: 0,
      suspended: r.suspended,
      reports: [],
    };
    g.reports.push(r);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.reporterCount = new Set(g.reports.map((r) => r.reporterName)).size;
  }
  // **멈춰 있는 것이 맨 위.** 판매가 이미 멈췄다는 것은 리서처가 지금 이 순간 돈을
  // 못 벌고 있다는 뜻이라, 맞든 틀리든 가장 먼저 답이 나와야 하는 건이다
  return [...groups.values()].sort((a, b) =>
    a.suspended === b.suspended ? b.reporterCount - a.reporterCount : a.suspended ? -1 : 1,
  );
}

export interface ReviewAbuseReportInput {
  id: string;
  operatorUserId: string;
  decision: 'CONFIRMED' | 'REJECTED';
  note: string;
  /**
   * 신고자에게 자동 통지를 보낼지 (기본 true).
   *
   * **강제 철회 경로에서만 끈다** (2026-08-20 사용자 확정). 그 경로에는 운영자가
   * 확인 창에서 사람마다 직접 쓴 쪽지가 있고, 자동 통지까지 나가면 같은 사람이
   * 같은 사건으로 두 통을 받는다 — 하나는 우리가 지은 말, 하나는 운영자가 쓴 말이라
   * 어느 쪽이 진짜 답인지 받는 사람이 판단해야 한다.
   *
   * ⚠ **끄면 보상 안내도 함께 꺼진다.** 첫 신고자에게 "보상 대상"이라고 알리던 것이
   * 그 통지였으므로, 그 말은 이제 운영자가 쪽지에 직접 적어야 한다(확인 창의 그 사람
   * 줄에 `보상 대상` 칩이 붙어 있고, 안내 완료는 rewardNoticedAt이 따로 센다).
   */
  notifyReporter?: boolean;
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
  const report = await prisma.abuseReport.findUnique({
    where: { id: input.id },
  });
  if (!report) throw new AbuseReportError('신고를 찾을 수 없습니다');
  if (report.status !== 'PENDING') throw new AbuseReportError('이미 검토가 끝난 신고입니다');

  // **한 리포트에는 첫 신고자만 보상 대상이다 (2026-08-19).**
  // 전에는 선착순 쿼터가 플랫폼 전체 100건뿐이라, 같은 리포트를 5명이 신고하고 운영자가
  // 다 확인하면 5명 모두 보상 대상이 되고 쿼터를 5개 먹었다. 리포트를 특정할 수 없어
  // 운영자도 중복인 줄 몰랐다. reportId가 붙으면서 이 구멍이 닫힌다.
  // 무엇보다 **화면이 두 번째 신고자에게 "보상은 먼저 신고한 분에게 갑니다"라고 미리
  // 말하므로**, 여기서 같은 규칙으로 집행하지 않으면 그 고지가 거짓말이 된다
  const alreadyRewardedForReport = report.reportId
    ? (await prisma.abuseReport.count({
        where: { reportId: report.reportId, rewarded: true },
      })) > 0
    : false;
  const rewarded =
    input.decision === 'CONFIRMED' &&
    !alreadyRewardedForReport &&
    (await rewardedCount(prisma)) < REWARD_QUOTA;

  const notify = input.notifyReporter !== false;

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
    ...(!notify
      ? []
      : [
          prisma.notification.create({
            data: {
              userId: report.reporterId,
              type: 'ABUSE_REPORT_RESULT',
              // 기각 통지는 **제목·본문이 고정 양식**이다 (2026-08-20 사용자 확정).
              // 제목은 그대로 푸시 문구가 되므로, 같은 처분이 사람마다 다른 얼굴로
              // 도착하지 않게 한곳(domain/notice)에서만 정한다
              title: input.decision === 'CONFIRMED' ? '신고가 확인되었습니다' : ABUSE_REPLY_TITLE,
              body:
                input.decision === 'CONFIRMED'
                  ? rewarded
                    ? // **지급 수단을 특정하지 않는다** (2026-08-18). 예전 문구는 "쿠폰이 지급될
                      // 예정입니다"였는데 쿠폰 발행·사용 기능이 없다 — 지킬 수 없는 약속이었다.
                      // 보상 자체는 실제로 한다(운영자가 개별 안내). 수단이 생기면 문구를 되돌린다
                      '신고하신 내용이 확인되어 해당 리포트에 조치했습니다. 보상 대상에 포함되었고, 지급 방법은 개별로 안내드리겠습니다. 클린 리서치에 함께해 주셔서 감사합니다.'
                    : // **왜 대상이 아닌지를 구별해서 말한다** — 두 사유가 완전히 다르다.
                      // 뭉뚱그려 "선착순 마감"이라고 하면, 신고 화면에서 "먼저 신고한 분에게
                      // 갑니다"를 읽고 그래도 남긴 사람에게 앞뒤가 안 맞는 말을 하게 된다
                      alreadyRewardedForReport
                      ? '신고하신 내용이 확인되어 해당 리포트에 조치했습니다. 이 리포트는 먼저 신고하신 분이 보상 대상이라 보상은 없지만, 남겨 주신 내용이 판단에 그대로 들어갔습니다. 감사합니다.'
                      : '신고하신 내용이 확인되어 해당 리포트에 조치했습니다. 보상은 선착순 수량이 마감되어 대상이 아니지만, 신고는 조치에 그대로 반영되었습니다.'
                  : ABUSE_REJECTED_REPORTER_BODY,
              link: '/clean',
            },
          }),
        ]),
  ]);

  // **확인했는데 리포트가 아직 팔리고 있으면 일러 준다** (2026-08-19).
  //
  // 판매 중단은 **PENDING 신고만** 센다(사람이 도착하면 카운터는 의미를 잃는다는 원칙).
  // 그 원칙의 대가가 여기다: 확인 처리로 신고가 PENDING을 벗어나면 카운트가 내려가
  // **위반이 확인된 리포트가 다시 팔릴 수 있다.** 조치는 강제 철회인데 그건 다른
  // 화면의 다른 버튼이라, 확인만 하고 넘어가는 실수가 실제로 가능하다.
  // 자동으로 내리지는 않는다 — 철회는 전액 환불·점수 0을 동반하는 불가역 처분이고,
  // 신고 확인이 곧 철회 결정은 아니다. 대신 잊히지 않게 소리를 낸다
  if (input.decision === 'CONFIRMED' && report.reportId) {
    const target = await prisma.report.findUnique({
      where: { id: report.reportId },
      select: { id: true, title: true, status: true, salesClosedAt: true },
    });
    if (target && target.status === 'PUBLISHED' && !target.salesClosedAt) {
      await notifyOperators(prisma, {
        title: '신고 확인 — 리포트가 아직 판매 중입니다',
        body: `「${target.title}」의 신고를 확인 처리했지만 리포트는 여전히 판매 중입니다. 강제 철회가 필요한지 확인해 주세요 (확인 처리만으로는 판매가 멈추지 않습니다).`,
        link: `/admin/compliance?tab=published`,
        dedupeKey: `abuse-confirmed-still-selling:${target.id}`,
      });
    }
  }

  return { ...updated, rewarded };
}
