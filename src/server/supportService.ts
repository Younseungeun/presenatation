import type { PrismaClient } from '@prisma/client';
import {
  isSupportTopic,
  SUPPORT_DAILY_LIMIT,
  SUPPORT_DETAIL_MAX,
  SUPPORT_DETAIL_MIN,
  SUPPORT_TOPIC_SPECS,
  type SupportTopic,
} from '@/domain/supportTopics';

// 문의 접수·처리. 주제 규칙은 domain/supportTopics.ts(순수)에 있고 여기는 표만 만진다.

export class SupportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupportError';
  }
}

export interface CreateSupportTicketInput {
  userId: string;
  topic: string;
  detail: string;
}

export async function createSupportTicket(
  prisma: PrismaClient,
  input: CreateSupportTicketInput,
  now = new Date(),
) {
  if (!isSupportTopic(input.topic)) throw new SupportError('알 수 없는 문의 주제입니다');
  const detail = input.detail.trim();
  if (detail.length < SUPPORT_DETAIL_MIN) {
    throw new SupportError(`문의 내용을 ${SUPPORT_DETAIL_MIN}자 이상 적어 주세요`);
  }
  if (detail.length > SUPPORT_DETAIL_MAX) {
    throw new SupportError(`문의 내용은 ${SUPPORT_DETAIL_MAX}자까지 적을 수 있습니다`);
  }

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const today = await prisma.supportTicket.count({
    where: { userId: input.userId, createdAt: { gte: startOfDay } },
  });
  if (today >= SUPPORT_DAILY_LIMIT) {
    throw new SupportError(
      `문의는 하루 ${SUPPORT_DAILY_LIMIT}건까지 접수할 수 있습니다. 내일 다시 시도해 주세요.`,
    );
  }

  // desk는 **접수 시점에 박는다** — 주제→화면 대응이 나중에 바뀌어도 처리 중인 건이
  // 다른 화면으로 옮겨 가 담당이 사라지는 일이 없어야 한다 (schema 주석 참고)
  return prisma.supportTicket.create({
    data: {
      userId: input.userId,
      topic: input.topic,
      desk: SUPPORT_TOPIC_SPECS[input.topic as SupportTopic].desk,
      detail,
    },
  });
}

/** 내 문의 목록 — 답변이 왔는지 보러 온다 */
export function getMySupportTickets(prisma: PrismaClient, userId: string) {
  return prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

/**
 * 운영자 목록 — **화면(desk)별로 가른다.**
 * 한 곳에 모아 두면 결국 거기서 다시 세 화면으로 흩어야 한다.
 */
export function getSupportTicketsForDesk(prisma: PrismaClient, desk: string) {
  return prisma.supportTicket.findMany({
    where: { desk, status: 'OPEN' },
    orderBy: { createdAt: 'asc' }, // 오래 기다린 순 — 답이 늦는 것 자체가 문제다
  });
}

export interface AnswerSupportTicketInput {
  id: string;
  operatorUserId: string;
  answer: string;
}

/**
 * 답변 — 알림을 **같은 트랜잭션**에서 만든다.
 *
 * 나눠 두면 "답변은 저장됐는데 이용자는 모르는" 창이 열리고, 그 건은 목록에서
 * 처리 완료로 보여 아무도 다시 안 본다. 알림 행 하나라 트랜잭션이 길어지지도 않는다
 * (푸시는 스윕이 나중에 따라간다 — server/pushService.ts).
 */
export async function answerSupportTicket(
  prisma: PrismaClient,
  input: AnswerSupportTicketInput,
  now = new Date(),
) {
  const answer = input.answer.trim();
  if (!answer) throw new SupportError('답변 내용은 필수입니다');
  const ticket = await prisma.supportTicket.findUnique({ where: { id: input.id } });
  if (!ticket) throw new SupportError('문의를 찾을 수 없습니다');
  if (ticket.status !== 'OPEN') throw new SupportError('이미 처리된 문의입니다');

  const [updated] = await prisma.$transaction([
    prisma.supportTicket.update({
      where: { id: input.id, status: 'OPEN' }, // 동시 처리 대비 원자적 전이
      data: { status: 'ANSWERED', answer, answeredAt: now, answeredBy: input.operatorUserId },
    }),
    prisma.notification.create({
      data: {
        userId: ticket.userId,
        type: 'SUPPORT_ANSWERED',
        title: '문의에 답변이 도착했어요',
        body: answer,
        link: '/support',
      },
    }),
  ]);
  return updated;
}

/**
 * 소통 화면 머리의 **한 줄 요약과 관찰문** (시안 v3 tk-ask).
 *
 * 두 값이 답하는 질문이 다르다:
 *   접수 건수    이번 달에 얼마나 왔나 — 창구가 감당되는 규모인가
 *   평균 답변    **얼마나 기다리게 했나** — 문의는 건수가 아니라 시간을 센다
 *
 * 그리고 **주제별 집계가 이 화면에서 가장 쓸모 있는 한 줄**이다. 한 주제가 계속
 * 올라온다는 것은 그 주제의 `selfServe`(폼 전에 먼저 보여주는 답)가 **안 읽히고
 * 있다**는 뜻이다 — 답을 잘 쓰는 것보다 그 문구를 고치는 쪽이 문의를 줄인다.
 * 창구를 넓히는 대신 창구에 올 이유를 없애는 것이 1인 운영의 유일한 길이다.
 */
export async function getSupportStats(prisma: PrismaClient, now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await prisma.supportTicket.findMany({
    where: { createdAt: { gte: monthStart } },
    select: { topic: true, createdAt: true, answeredAt: true },
  });

  const answered = rows.filter((r) => r.answeredAt !== null);
  const avgAnswerMs =
    answered.length === 0
      ? null
      : answered.reduce((s, r) => s + (r.answeredAt!.getTime() - r.createdAt.getTime()), 0) /
        answered.length;

  const byTopic = new Map<string, number>();
  for (const r of rows) byTopic.set(r.topic, (byTopic.get(r.topic) ?? 0) + 1);
  const ranked = [...byTopic.entries()].sort((a, b) => b[1] - a[1]);
  const [topTopic, topCount] = ranked[0] ?? [null, 0];

  return {
    received: rows.length,
    answered: answered.length,
    avgAnswerMs,
    topTopic: topTopic as SupportTopic | null,
    topCount,
    /** 그 주제에 이미 안내가 있는가 — 있는데도 계속 오면 안내가 안 읽히는 것이다 */
    topHasSelfServe:
      topTopic !== null && isSupportTopic(topTopic)
        ? SUPPORT_TOPIC_SPECS[topTopic].selfServe.length > 0
        : false,
  };
}
