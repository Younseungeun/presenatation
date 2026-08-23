import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCREENING_CANARY } from '@/domain/screeningCanary';
import {
  CANARY_HEARTBEAT_KEY,
  CANARY_STALE_MS,
  getCanaryScreen,
} from '../screeningCanaryRunner';
import { createTestDb } from './helpers/testDb';

// 관리자 화면이 읽는 검수 상태 (2026-08-21).
//
// **두 고장을 따로 답한다**: 규칙이 지금 죽었나(직접 재서) / 자동 점검이 도나(박동).
// 하나로 합치면 "규칙은 멀쩡한데 스케줄러만 죽은" 상태가 화면에서 사라진다 —
// 그때가 정확히 **다음 고장을 아무도 먼저 알려주지 않는** 상태다.

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createTestDb('canary-screen-');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('getCanaryScreen', () => {
  it('박동이 아예 없으면 낡은 것으로 본다 — 한 번도 안 돈 것과 멈춘 것은 같은 처지다', async () => {
    const s = await getCanaryScreen(prisma);
    expect(s.lastOkAt).toBeNull();
    expect(s.heartbeatStale).toBe(true);
    // 규칙 자체는 잰다 — 스케줄러가 죽었다고 규칙까지 못 재는 것은 아니다
    expect(s.ran).toBe(SCREENING_CANARY.length);
  });

  it('방금 찍힌 박동은 낡지 않았다', async () => {
    const now = new Date('2026-08-21T09:00:00Z');
    await prisma.appSetting.upsert({
      where: { key: CANARY_HEARTBEAT_KEY },
      create: { key: CANARY_HEARTBEAT_KEY, value: new Date(now.getTime() - 60_000).toISOString() },
      update: { value: new Date(now.getTime() - 60_000).toISOString() },
    });
    const s = await getCanaryScreen(prisma, now);
    expect(s.heartbeatStale).toBe(false);
    expect(s.lastOkAt?.toISOString()).toBe(new Date(now.getTime() - 60_000).toISOString());
  });

  it('상한을 넘긴 박동은 낡았다 — 규칙이 멀쩡해도 그 사실은 따로 말해야 한다', async () => {
    const now = new Date('2026-08-21T09:00:00Z');
    const old = new Date(now.getTime() - CANARY_STALE_MS - 60_000);
    await prisma.appSetting.update({
      where: { key: CANARY_HEARTBEAT_KEY },
      data: { value: old.toISOString() },
    });
    const s = await getCanaryScreen(prisma, now);
    expect(s.heartbeatStale).toBe(true);
    // **두 값이 서로를 덮지 않는다** — 박동 판정은 규칙 결과와 무관하게 나온다.
    // (규칙 쪽 결과 자체는 여기서 검사하지 않는다: 시험 DB에 종목 마스터가 없어
    //  표기 회피 층이 설계대로 침묵하는데, 그건 이 시험이 재려는 것이 아니다 —
    //  그 성질은 screeningCanary.test.ts가 이미 붙잡고 있다)
    expect(s.ran).toBe(SCREENING_CANARY.length);
  });

  it('망가진 박동 값에도 화면을 죽이지 않는다', async () => {
    await prisma.appSetting.update({
      where: { key: CANARY_HEARTBEAT_KEY },
      data: { value: '박동아님' },
    });
    const s = await getCanaryScreen(prisma);
    expect(s.lastOkAt).toBeNull();
    expect(s.heartbeatStale).toBe(true);
  });
});
