import type { PrismaClient } from '@prisma/client';

// 스케줄러 생사 확인 — **"살아 있다"와 "일하고 있다"는 다르다.**
//
// 판정·정산·환불 스윕·의도 정리가 전부 이 프로세스 하나를 지난다(KIS 토큰이 분당 1회라
// 의도적으로 하나다). 그래서 이게 멈추면 돈이 움직이는 일이 통째로 멈춘다.
//
// pm2에 맡길 수 없는 이유: pm2는 **죽은 것**만 살린다. 이벤트 루프가 막히거나 프로미스가
// 영원히 안 풀리는 좀비 상태는 "online"으로 보인다 — 가장 위험한 상태가 가장 멀쩡해 보인다.
// 그래서 프로세스가 **매 사이클 끝에 스스로 서명**하고, 그 서명이 낡았는지는 밖에서 본다.

/** 이 값보다 오래된 심박은 "멈춘 것으로 본다" */
export const HEARTBEAT_STALE_MS = 15 * 60_000;
/** 부팅 시 다른 스케줄러가 살아 있다고 보는 기준 — 틱 주기(1분)보다 넉넉히 */
export const HEARTBEAT_TAKEOVER_MS = 3 * 60_000;

const KEY = 'scheduler.heartbeat';

/** 매 사이클 끝에 서명한다 (스케줄러 자신) */
export async function writeHeartbeat(prisma: PrismaClient, now = new Date()): Promise<void> {
  try {
    const value = now.toISOString();
    await prisma.appSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, updatedBy: 'scheduler' },
      update: { value, updatedBy: 'scheduler' },
    });
  } catch (e) {
    // 심박을 못 써도 본업(판정·정산)은 계속해야 한다 — 계측이 본업을 죽이면 안 된다
    console.error('심박 기록 실패:', e);
  }
}

export interface SchedulerHealth {
  lastBeatAt: Date | null;
  ageMs: number | null;
  stale: boolean;
}

export async function readHeartbeat(
  prisma: PrismaClient,
  now = new Date(),
): Promise<SchedulerHealth> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { value: true } });
  if (!row) return { lastBeatAt: null, ageMs: null, stale: true };
  const lastBeatAt = new Date(row.value);
  const ageMs = now.getTime() - lastBeatAt.getTime();
  return { lastBeatAt, ageMs, stale: ageMs > HEARTBEAT_STALE_MS };
}

/**
 * 다른 스케줄러가 돌고 있을 **가능성**이 보이나 — 경고용이지 잠금이 아니다.
 *
 * 두 대가 동시에 돌면 안 되는 건 맞다(KIS 토큰 분당 1회, 호출 간격도 계정 합산이라
 * 서로를 모른 채 두드리면 양쪽 다 차단당한다). 그런데 **심박으로 부팅을 막으면 병보다
 * 약이 나쁘다**: pm2가 재시작하면 새 프로세스가 몇 초 만에 뜨는데, 그때 심박은 방금
 * 죽은 자기 자신의 것이라 여전히 싱싱하다 → 새 프로세스가 "다른 놈이 있다"며 죽고,
 * pm2가 또 띄우고, **정상 배포가 크래시 루프**가 된다.
 *
 * 정상 종료 때 심박을 지우면 되지 않느냐 — 크래시(OOM·SIGKILL)에는 그 경로가 안 돈다.
 * 그러면 진짜 사고 직후에 몇 분간 못 뜨는데, 그게 가장 빨리 떠야 할 때다.
 *
 * **제대로 된 상호배제는 Postgres advisory lock이다** — 세션에 묶여 있어 연결이 끊기면
 * 자동으로 풀린다(크래시에도 정확하다). SQLite에는 없으므로, 전환 전까지는 pm2 설정으로
 * 1대를 보장하고 여기서는 **의심스러우면 경고만** 남긴다.
 */
export async function anotherSchedulerMayBeRunning(
  prisma: PrismaClient,
  now = new Date(),
): Promise<boolean> {
  const { ageMs } = await readHeartbeat(prisma, now);
  return ageMs !== null && ageMs < HEARTBEAT_TAKEOVER_MS;
}

/** 정상 종료 — 심박을 지워 "멈춰 있다"가 즉시 정직하게 보이게 한다 */
export async function clearHeartbeat(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.appSetting.deleteMany({ where: { key: KEY } });
  } catch {
    /* 종료 중이라 실패해도 할 일이 없다 */
  }
}
