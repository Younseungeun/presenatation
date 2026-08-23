import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoticeError, sendNotice, countNoticeRecipients } from '../noticeService';
import { createTestDb } from './helpers/testDb';

// 운영자 공지 — **관리자 화면과 이용자 앱을 잇는 마지막 통로** (2026-08-19).
//
// 이 파일이 지키는 명제 넷:
//   ① 보낸 글이 **모든 대상의 알림함에** 그대로 도착한다 (연동의 전부)
//   ② 범위를 고르면 **그 사람들에게만** 간다
//   ③ 종목·수익·매매 이야기는 **규칙이 막는다** — 공지는 검수를 안 거친다
//   ④ 사람이 몇이든 **트랜잭션 문장 수가 같다** (createMany 한 문장)

let prisma: PrismaClient;
let operatorId: string;
const researcherUserIds: string[] = [];
const plainUserIds: string[] = [];

beforeAll(async () => {
  prisma = createTestDb('notice-');

  const op = await prisma.user.create({
    data: { email: 'op@notice.io', role: 'OPERATOR', identityVerified: true },
  });
  operatorId = op.id;

  for (let i = 0; i < 3; i++) {
    const u = await prisma.user.create({
      data: {
        email: `res${i}@notice.io`,
        identityVerified: true,
        researcherProfile: { create: {} },
      },
    });
    researcherUserIds.push(u.id);
  }
  for (let i = 0; i < 2; i++) {
    const u = await prisma.user.create({
      data: { email: `buyer${i}@notice.io`, identityVerified: true },
    });
    plainUserIds.push(u.id);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('운영자 공지', () => {
  it('전체 공지가 모든 계정의 알림함에 도착한다', async () => {
    const total = await countNoticeRecipients(prisma, 'ALL');
    // 운영자 1 + 리서처 3 + 구매자 2
    expect(total).toBe(6);

    const { recipients } = await sendNotice(prisma, {
      title: '8월 20일 새벽 점검 안내',
      body: '02:00~04:00 사이 결제와 알림이 잠시 멈춥니다. 판정 배치는 영향받지 않습니다.',
      audience: 'ALL',
      operatorUserId: operatorId,
    });
    expect(recipients).toBe(6);

    const notes = await prisma.notification.findMany({ where: { type: 'OPERATOR_NOTICE' } });
    expect(notes).toHaveLength(6);
    // 받는 사람이 겹치거나 빠지지 않는다
    expect(new Set(notes.map((n) => n.userId)).size).toBe(6);
    // **글이 그대로 간다** — 요약하거나 자르지 않는다
    expect(notes[0].title).toBe('8월 20일 새벽 점검 안내');
    expect(notes[0].body).toContain('02:00~04:00');
    // 열어 볼 화면이 없으므로 링크를 만들지 않는다 (없는 곳으로 보내면 고장으로 읽힌다)
    expect(notes[0].link).toBeNull();
    // 푸시는 여기서 보내지 않는다 — 비워 두면 스윕이 주워 간다
    expect(notes[0].pushedAt).toBeNull();
  });

  it('세는 함수와 보내는 함수가 같은 사람을 센다', async () => {
    // 갈라지는 순간 "1,284명에게 보내기"라고 적힌 버튼이 거짓말을 한다
    for (const aud of ['ALL', 'RESEARCHER', 'BUYER', 'HOLDER'] as const) {
      const counted = await countNoticeRecipients(prisma, aud);
      if (counted === 0) continue; // 0명이면 발송 자체가 막힌다 (아래 시험이 따로 본다)
      const sent = await sendNotice(prisma, {
        title: `범위 확인 ${aud}`,
        body: '앱을 최신 버전으로 업데이트해 주세요. 감사합니다.',
        audience: aud,
        operatorUserId: operatorId,
      });
      expect(sent.recipients, `${aud}의 미리 센 수와 실제 발송 수가 같아야 한다`).toBe(counted);
    }
    await prisma.notification.deleteMany({ where: { type: 'OPERATOR_NOTICE' } });
    await prisma.notice.deleteMany({ where: { title: { startsWith: '범위 확인' } } });
  });

  it('리서처 공지는 리서처에게만 간다', async () => {
    await prisma.notification.deleteMany({ where: { type: 'OPERATOR_NOTICE' } });

    const { recipients } = await sendNotice(prisma, {
      title: '정산 지급일 변경',
      body: '이번 주 지급은 목요일에 함께 나갑니다. 정산 내역은 MY에서 확인하세요.',
      audience: 'RESEARCHER',
      operatorUserId: operatorId,
    });
    expect(recipients).toBe(3);

    const got = await prisma.notification.findMany({ where: { type: 'OPERATOR_NOTICE' } });
    expect(got.map((n) => n.userId).sort()).toEqual([...researcherUserIds].sort());
    // 구매자에게는 한 통도 안 간다
    for (const id of plainUserIds) {
      expect(got.some((n) => n.userId === id)).toBe(false);
    }
  });

  it('보낸 기록이 남는다 — 보낸 순간의 사람 수까지', async () => {
    const notices = await prisma.notice.findMany({ orderBy: { sentAt: 'asc' } });
    expect(notices).toHaveLength(2);
    expect(notices[0].audience).toBe('ALL');
    expect(notices[0].recipients).toBe(6);
    expect(notices[1].audience).toBe('RESEARCHER');
    expect(notices[1].recipients).toBe(3);
    expect(notices[1].sentBy).toBe(operatorId);
  });

  it('종목·수익·매매 이야기는 막는다 — 공지는 검수를 거치지 않는다', async () => {
    const banned = [
      '지금이 매수 타이밍입니다',
      '이번 달 수익률이 좋았습니다',
      '유망 종목을 소개합니다',
    ];
    for (const body of banned) {
      await expect(
        sendNotice(prisma, {
          title: '안내',
          body: `${body} 자세한 내용은 앱에서 확인해 주세요.`,
          audience: 'ALL',
          operatorUserId: operatorId,
        }),
      ).rejects.toBeInstanceOf(NoticeError);
    }
  });

  it('제목에 숨겨도 막힌다 — 제목과 본문을 함께 본다', async () => {
    await expect(
      sendNotice(prisma, {
        title: '급등 종목 안내',
        body: '앱을 최신 버전으로 업데이트해 주세요. 감사합니다.',
        audience: 'ALL',
        operatorUserId: operatorId,
      }),
    ).rejects.toThrow(/쓸 수 없는 표현/);
  });

  it('본문이 너무 짧으면 보내지 않는다', async () => {
    await expect(
      sendNotice(prisma, {
        title: '안내',
        body: '점검',
        audience: 'ALL',
        operatorUserId: operatorId,
      }),
    ).rejects.toThrow(/이상 적어/);
  });

  it('막힌 발송은 알림도 기록도 남기지 않는다', async () => {
    const before = await prisma.notice.count();
    const notesBefore = await prisma.notification.count();
    await expect(
      sendNotice(prisma, {
        title: '안내',
        body: '원금 보장 정책이 바뀌었습니다. 확인해 주세요.',
        audience: 'ALL',
        operatorUserId: operatorId,
      }),
    ).rejects.toBeInstanceOf(NoticeError);
    expect(await prisma.notice.count()).toBe(before);
    expect(await prisma.notification.count()).toBe(notesBefore);
  });
});
