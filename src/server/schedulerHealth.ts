import type { PrismaClient } from '@prisma/client';

// 스케줄러 생사 확인 — **"살아 있다"와 "일이 되고 있다"는 다른 질문이다.**
//
// 판정·정산·환불 스윕·의도 정리가 전부 이 프로세스 하나를 지난다(KIS 토큰이 분당 1회라
// 의도적으로 하나다). 그래서 이게 멈추면 돈이 움직이는 일이 통째로 멈춘다.
//
// pm2에 맡길 수 없는 이유: pm2는 **죽은 것**만 살린다. 이벤트 루프가 막히거나 프로미스가
// 영원히 안 풀리는 좀비 상태는 "online"으로 보인다 — 가장 위험한 상태가 가장 멀쩡해 보인다.
//
// **두 질문을 한 숫자로 답하려던 것이 설계 실수였다.** 처음에는 심박을 큐 맨 뒤에
// 세워 "일이 됐다"의 증거로 썼는데, 그러면 문턱을 **가장 긴 작업**에 맞춰야 해서
// (밀린 판정 소진이 15분을 넘을 수 있다) 정작 프로세스가 죽었을 때의 탐지가 그만큼
// 늦어졌다. 문턱을 조이면 열심히 일하는 순간에 거짓 경보가 나고, 늦추면 진짜 죽음을
// 늦게 안다 — 한 숫자로는 둘 다 만족시킬 수 없다.
//
// 그래서 나눈다:
//   ① **살아 있나** (at)      — 큐와 무관한 타이머가 찍는다. 이벤트 루프가 막히면 멈춘다.
//                               우리 작업은 전부 await하는 I/O라 2분을 막을 정당한 이유가
//                               없다 → 문턱을 짧게 잡아도 거짓 경보가 안 난다
//   ② **일이 되고 있나** (running/since) — 지금 도는 항목과 그게 시작한 시각.
//                               프로미스가 안 풀리는 좀비는 ①이 계속 뛰는 채로 ②가 멈춘다
//
// 큐 안쪽마다 심박을 심는 대안도 있었지만 택하지 않았다: 짧은 문턱이 **앞으로 추가될
// 모든 배치가 심박을 잊지 않는 것**에 의존하게 되고, 하나만 빠뜨려도 거짓 경보가 난다.
// 지금 설계의 문턱은 이벤트 루프 말고는 아무것에도 의존하지 않는다. 덤으로 ②는 **멈춘
// 배치의 이름**을 말해 주는데, 심박을 빨리 찍는 것으로는 절대 알 수 없는 정보다.

/** 심박 주기 — 문턱(2분)에 네 번의 여유 */
export const BEAT_INTERVAL_MS = 30_000;
/** 이 값보다 오래된 심박은 "프로세스가 멈춘 것으로 본다" */
export const LIVENESS_STALE_MS = 2 * 60_000;
/**
 * 한 항목이 이만큼 안 끝나면 "막힌 것으로 본다".
 *
 * 가장 긴 정당한 항목은 시장 하나의 밀린 판정 소진(최대 800장 × 1.1초 ≈ 15분)이다.
 * 기동 따라잡기를 시장별로 쪼갠 이유가 이것 — 셋을 한 항목으로 두면 45분짜리가 생겨
 * 이 문턱이 그만큼 헐거워진다. 판정은 회차(20장 ≈ 22초)마다 시작 시각을 갱신하므로
 * 실제로는 훨씬 이르게 잡힌다
 */
export const ITEM_STUCK_MS = 30 * 60_000;
/** 부팅 시 다른 스케줄러가 살아 있다고 보는 기준 — 심박 주기보다 넉넉히 */
export const HEARTBEAT_TAKEOVER_MS = 3 * 60_000;

const KEY = 'scheduler.heartbeat';

/** 지금 큐에서 도는 항목 — 없으면 놀고 있다 */
export interface RunningItem {
  label: string;
  since: Date;
}

/** DB에 남기지 않고 못 쓴 심박이 쌓이는 것을 막는다 (DB가 멎으면 다음 주기를 건너뛴다) */
let beating = false;

/** 주기 타이머가 부른다 (스케줄러 자신) — 큐 뒤가 아니라 큐 **옆**이다 */
export async function writeHeartbeat(
  prisma: PrismaClient,
  running: RunningItem | null = null,
  now = new Date(),
): Promise<void> {
  if (beating) return;
  beating = true;
  try {
    const value = JSON.stringify({
      at: now.toISOString(),
      running: running?.label ?? null,
      since: running?.since.toISOString() ?? null,
    });
    await prisma.appSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, updatedBy: 'scheduler' },
      update: { value, updatedBy: 'scheduler' },
    });
  } catch (e) {
    // 심박을 못 써도 본업(판정·정산)은 계속해야 한다 — 계측이 본업을 죽이면 안 된다
    console.error('심박 기록 실패:', e);
  } finally {
    beating = false;
  }
}

export interface SchedulerHealth {
  lastBeatAt: Date | null;
  ageMs: number | null;
  /** 프로세스가 멈췄나 */
  stale: boolean;
  /** 지금 도는 항목 (놀고 있으면 null) */
  running: string | null;
  runningForMs: number | null;
  /** 한 항목이 안 끝나고 있나 — 프로세스는 살아 있는데 일이 안 되는 상태 */
  stuck: boolean;
}

interface StoredBeat {
  at?: string;
  running?: string | null;
  since?: string | null;
}

export async function readHeartbeat(
  prisma: PrismaClient,
  now = new Date(),
): Promise<SchedulerHealth> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { value: true } });
  const idle = { running: null, runningForMs: null, stuck: false };
  if (!row) return { lastBeatAt: null, ageMs: null, stale: true, ...idle };

  let beat: StoredBeat;
  try {
    beat = JSON.parse(row.value) as StoredBeat;
  } catch {
    // 옛 형식(ISO 문자열 하나)이 남아 있을 수 있다 — 배포 직후 한 주기 동안만이다
    beat = { at: row.value };
  }
  if (!beat.at) return { lastBeatAt: null, ageMs: null, stale: true, ...idle };

  const lastBeatAt = new Date(beat.at);
  const ageMs = now.getTime() - lastBeatAt.getTime();
  const since = beat.since ? new Date(beat.since) : null;
  const runningForMs = since ? now.getTime() - since.getTime() : null;
  return {
    lastBeatAt,
    ageMs,
    stale: ageMs > LIVENESS_STALE_MS,
    running: beat.running ?? null,
    runningForMs,
    stuck: runningForMs !== null && runningForMs > ITEM_STUCK_MS,
  };
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
 * 자동으로 풀린다(크래시에도 정확하다). 실제 충돌 경로는 무중단 배포가 아니라
 * **사람이 `npm run batch:judge`를 손으로 돌리는 것**이다(스케줄러가 떠 있는 채로).
 * 그때 두 프로세스의 호출 간격 게이트가 서로를 모른 채 KIS를 두드린다.
 * SQLite에는 advisory lock이 없으므로, 전환 전까지는 **의심스러우면 경고만** 남긴다.
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
