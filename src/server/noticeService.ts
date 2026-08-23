import type { PrismaClient } from '@prisma/client';
import {
  checkNoticeText,
  isNoticeAudience,
  NOTICE_DIRECT,
  type NoticeAudience,
} from '@/domain/notice';

// 공지 발송 — 관리자 화면에서 쓴 글이 이용자 알림함에 도착하는 통로.
//
// **문장 수가 사람 수에 비례하면 안 된다** (CLAUDE.md — 판정 트랜잭션과 같은 이유).
// 1,000명에게 보낸다고 1,000개의 INSERT를 돌면 그동안 쓰기 락이 잡혀 결제가 죽는다.
// `createMany` 한 문장이면 사람이 몇이든 트랜잭션 길이가 같다.
//
// **푸시는 여기서 보내지 않는다.** Notification.pushedAt이 비어 있으면 스윕이
// 주워 가므로(schema 주석) 새 알림 종류가 저절로 따라온다 — 이 경로에 발송 코드를
// 심으면 다음에 또 심어야 하고, 언젠가 빠뜨린다.

export class NoticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoticeError';
  }
}

export interface SendNoticeInput {
  title: string;
  body: string;
  audience: string;
  operatorUserId: string;
}

/**
 * 받는 사람을 고른다 — **여기 말고 다른 곳에서 범위를 해석하지 않는다.**
 * 화면이 미리 세는 수(countNoticeRecipients)와 실제로 받는 사람이 갈라지면
 * "1,284명에게 보내기"라고 적힌 버튼이 거짓말을 한다.
 */
async function recipientIds(
  prisma: PrismaClient,
  audience: NoticeAudience,
): Promise<string[]> {
  if (audience === 'RESEARCHER') {
    const rows = await prisma.researcherProfile.findMany({ select: { userId: true } });
    return rows.map((r) => r.userId);
  }
  if (audience === 'BUYER') {
    const rows = await prisma.purchase.findMany({
      select: { buyerId: true },
      distinct: ['buyerId'],
    });
    return rows.map((r) => r.buyerId);
  }
  if (audience === 'HOLDER') {
    // **아직 결과를 기다리는 사람** — 판정이 끝난 카드의 구매자는 여기 없다.
    // "판정이 멈췄습니다"가 뜻을 갖는 유일한 범위다
    const rows = await prisma.purchase.findMany({
      where: { report: { predictionCard: { judgment: null } } },
      select: { buyerId: true },
      distinct: ['buyerId'],
    });
    return rows.map((r) => r.buyerId);
  }
  const rows = await prisma.user.findMany({ select: { id: true } });
  return rows.map((r) => r.id);
}

export async function sendNotice(
  prisma: PrismaClient,
  input: SendNoticeInput,
  now = new Date(),
) {
  if (!isNoticeAudience(input.audience)) throw new NoticeError('받는 범위가 올바르지 않습니다');
  const check = checkNoticeText(input.title, input.body);
  if (!check.ok) throw new NoticeError(check.reason ?? '공지 내용을 확인해 주세요');

  const title = input.title.trim();
  const body = input.body.trim();
  const ids = await recipientIds(prisma, input.audience);

  // **받는 사람이 없으면 보내지 않는다.** 0명에게 보낸 것을 발송으로 기록하면
  // 목록이 "보냈다"고 말하는데 아무도 못 받은 건이 남는다
  if (ids.length === 0) throw new NoticeError('받을 사람이 없습니다');

  const [, notice] = await prisma.$transaction([
    prisma.notification.createMany({
      data: ids.map((userId) => ({
        userId,
        type: 'OPERATOR_NOTICE',
        title,
        body,
        // 공지는 따로 열어 볼 화면이 없다 — 본문이 전부라 링크를 만들지 않는다.
        // 없는 곳으로 보내는 링크는 알림을 눌러 본 사람에게 고장으로 읽힌다
        link: null,
      })),
    }),
    prisma.notice.create({
      data: {
        title,
        body,
        audience: input.audience,
        recipients: ids.length,
        sentBy: input.operatorUserId,
        sentAt: now,
      },
    }),
  ]);

  return { notice, recipients: ids.length };
}

/**
 * **한 사람에게만 보내는 쪽지** (2026-08-20 사용자 지시).
 *
 * 지금까지 운영자가 이용자에게 먼저 말하는 길은 **전체 공지 하나뿐**이었다. 그런데
 * 실제로 말을 걸어야 하는 상대는 대개 한 사람이다 — 신고를 남긴 사람에게 "확인했고
 * 이렇게 처리했습니다"라고 답하는 자리가 없어서, 신고자는 자기 신고가 어떻게 됐는지
 * 영영 모른 채였다(확인·기각 통지는 판단을 내려야 나가고, 그 전에 물어볼 말이 있다).
 *
 * 공지와 **같은 규칙·같은 표**를 쓴다:
 *  · 같은 금지 어휘 검사 — 한 사람에게 가는 말도 플랫폼 이름으로 나간다. 오히려
 *    1:1이라 투자자문으로 읽힐 여지가 더 크다(유사투자자문업 경계, CLAUDE.md §1)
 *  · 같은 Notice 표 — "무엇을 언제 누구에게"의 답이 두 곳으로 갈리면 안 된다
 *  · 링크 없음 — 공지와 같이 본문이 전부다
 */
export async function sendDirectNotice(
  prisma: PrismaClient,
  input: { userId: string; title: string; body: string; operatorUserId: string },
  now = new Date(),
) {
  const check = checkNoticeText(input.title, input.body);
  if (!check.ok) throw new NoticeError(check.reason ?? '내용을 확인해 주세요');

  const title = input.title.trim();
  const body = input.body.trim();

  // 없는 사람에게 보낸 것을 발송으로 기록하지 않는다 (0명 공지를 막는 것과 같은 이유)
  const target = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  });
  if (!target) throw new NoticeError('받을 사람을 찾을 수 없습니다');

  const [, notice] = await prisma.$transaction([
    prisma.notification.create({
      data: { userId: target.id, type: 'OPERATOR_NOTICE', title, body, link: null },
    }),
    prisma.notice.create({
      data: {
        title,
        body,
        audience: NOTICE_DIRECT,
        recipients: 1,
        sentBy: input.operatorUserId,
        sentAt: now,
      },
    }),
  ]);

  return { notice };
}

/** 보낸 공지 — 관리자 화면이 "무엇을 언제 보냈나"를 보여주는 자리 */
export function getRecentNotices(prisma: PrismaClient, take = 5) {
  return prisma.notice.findMany({ orderBy: { sentAt: 'desc' }, take });
}

/**
 * 보내기 전에 몇 명에게 가는지 — 화면이 숫자를 먼저 보여줘야 손이 멈춘다.
 * **발송이 쓰는 것과 같은 함수로 센다** — 따로 세면 언젠가 갈라지고,
 * 갈라지는 순간 버튼에 적힌 숫자가 거짓이 된다
 */
export async function countNoticeRecipients(
  prisma: PrismaClient,
  audience: NoticeAudience,
): Promise<number> {
  return (await recipientIds(prisma, audience)).length;
}
