import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  ITEM_STUCK_MS,
  LIVENESS_STALE_MS,
  clearHeartbeat,
  readHeartbeat,
  writeHeartbeat,
} from '../schedulerHealth';

// **"프로세스가 살아 있나"와 "일이 되고 있나"는 다른 질문이다.**
//
// 한 숫자로 답하려던 것이 설계 실수였다: 심박을 큐 맨 뒤에 세우면 문턱을 **가장 긴
// 작업**(밀린 판정 소진 15분)에 맞춰야 하고, 그러면 정작 프로세스가 죽었을 때의 탐지가
// 그만큼 늦어진다. 조이면 열심히 일하는 순간에 거짓 경보가 난다.
//
// 그래서 심박을 큐 **옆**의 타이머로 옮기고(살아 있나), 도는 항목과 시작 시각을 함께
// 실었다(일이 되고 있나). 이 시험이 고정하는 것은 **두 고장이 서로 다르게 읽힌다**는 것이다.

let prisma: PrismaClient;
const T0 = new Date('2026-08-14T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('sched-health-');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('스케줄러 심박', () => {
  it('심박이 없으면 멈춘 것으로 본다 — 모르는 상태를 "정상"으로 답하지 않는다', async () => {
    const h = await readHeartbeat(prisma, T0);
    expect(h.stale).toBe(true);
    expect(h.lastBeatAt).toBeNull();
  });

  it('놀고 있어도 살아 있다 — 할 일이 없는 것은 고장이 아니다', async () => {
    await writeHeartbeat(prisma, null, T0);
    const h = await readHeartbeat(prisma, new Date(T0.getTime() + 30_000));
    expect(h.stale).toBe(false);
    expect(h.running).toBeNull();
    expect(h.stuck).toBe(false);
  });

  it('심박이 끊기면 멈춘 것으로 본다 (이벤트 루프가 막힌 상태)', async () => {
    await writeHeartbeat(prisma, null, T0);
    const h = await readHeartbeat(prisma, new Date(T0.getTime() + LIVENESS_STALE_MS + 1_000));
    expect(h.stale).toBe(true);
  });

  // **좀비의 정확한 모습**: 프로세스는 멀쩡한데 프로미스 하나가 안 풀린다.
  // 심박만 보면 영원히 "정상"이라, 이 경우를 잡는 것이 running/since의 존재 이유다
  it('심박은 뛰는데 한 항목이 안 끝나면 막힌 것으로 본다 — 그리고 이름을 말한다', async () => {
    const since = new Date(T0.getTime());
    const now = new Date(T0.getTime() + ITEM_STUCK_MS + 60_000);
    // 심박 자체는 방금 찍혔다 (프로세스는 살아 있다)
    await writeHeartbeat(prisma, { label: 'KR_EQUITY 마감 판정', since }, now);

    const h = await readHeartbeat(prisma, now);
    expect(h.stale).toBe(false); // 죽지 않았다
    expect(h.stuck).toBe(true); // 그런데 일이 안 된다
    // 빠른 심박으로는 절대 알 수 없는 정보 — 무엇이 막혔는가
    expect(h.running).toBe('KR_EQUITY 마감 판정');
    expect(h.runningForMs).toBeGreaterThan(ITEM_STUCK_MS);
  });

  it('진척을 알리면 막힘 시계가 되감긴다 — 긴 배치가 회차마다 스스로 증명한다', async () => {
    const now = new Date(T0.getTime() + ITEM_STUCK_MS + 60_000);
    // 방금 한 회차를 끝냈다 → since가 지금으로 당겨진다 (runScheduler.markProgress)
    await writeHeartbeat(prisma, { label: '기동 따라잡기 CRYPTO', since: now }, now);

    const h = await readHeartbeat(prisma, now);
    expect(h.stuck).toBe(false);
    expect(h.running).toBe('기동 따라잡기 CRYPTO');
  });

  it('정상 종료는 심박을 지운다 — 멈춘 것이 즉시 정직하게 보인다', async () => {
    await writeHeartbeat(prisma, null, T0);
    await clearHeartbeat(prisma);
    const h = await readHeartbeat(prisma, T0);
    expect(h.stale).toBe(true);
  });

  // 배포 직후 한 주기 동안은 옛 형식(ISO 문자열 하나)이 DB에 남아 있다.
  // 파싱에 실패해 "죽었다"고 답하면 배포마다 거짓 경보가 난다
  it('옛 형식 심박도 읽는다 — 배포 직후 한 주기의 거짓 경보를 막는다', async () => {
    await prisma.appSetting.upsert({
      where: { key: 'scheduler.heartbeat' },
      create: { key: 'scheduler.heartbeat', value: T0.toISOString() },
      update: { value: T0.toISOString() },
    });
    const h = await readHeartbeat(prisma, new Date(T0.getTime() + 30_000));
    expect(h.stale).toBe(false);
    expect(h.running).toBeNull();
  });
});
