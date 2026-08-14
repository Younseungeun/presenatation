import type { PrismaClient } from '@prisma/client';

// **같은 배치가 두 벌 동시에 돌지 않게 한다** (2026-08-15).
//
// ── 무엇이 진짜 위험인가 (외부 검토 반박) ────────────────────
// 검토가 "배치가 중간에 죽고 재실행되면 이미 정산된 건이 다시 나가 **이중 지불**이
// 난다"고 했다. **우리 구조에서는 일어나지 않는다** — 두 겹으로 막혀 있다:
//
//   ① 배치는 **돈을 움직이지 않는다.** Settlement는 지시서일 뿐이고 실제 PG 취소·
//      지급은 운영자 콘솔에서만 실행된다(refundExecutedAt·payoutExecutedAt 가드 +
//      RefundAttempt의 멱등키). 배치를 백 번 돌려도 돈은 한 번도 안 나간다
//   ② 배치는 `judgment: null`인 카드만 집고 `Judgment.predictionCardId`가 unique다.
//      이미 판정된 카드는 조회에서 빠지고, 설령 경합해도 두 번째는 제약에 걸린다
//      (judgmentBatch.db.test.ts "멱등성: 배치 재실행해도 중복 판정·중복 정산 없음")
//
// **그런데 동시 실행은 다른 이유로 실제 문제다.** 순차 재실행(①②가 막는 것)과
// 동시 실행은 다른 사건이다:
//
//   · **KIS 토큰 발급이 분당 1회**다. 두 배치가 같은 분에 뜨면 하나가 통째로 실패한다
//     (이 제약이 애초에 "프로세스 하나의 순차 큐"를 고른 이유다 — CLAUDE.md §2.2)
//   · 같은 카드를 동시에 집으면 진 쪽이 unique 제약 오류를 받고, 그것이 `failures`에
//     담겨 **"우리 버그"로 분류된 운영자 알림**이 뜬다. 돈은 안 새지만 경보가 거짓말을 한다
//   · 진짜 경로는 두 스케줄러가 아니라 **스케줄러 + 사람이 손으로 돌린 `npm run batch:judge`**다.
//     스케줄러 중복은 이미 심박으로 경고하지만(anotherSchedulerMayBeRunning) 수동 실행은
//     아무 데도 안 걸린다
//
// ── 왜 파일 락이 아니라 DB 락인가 ────────────────────────────
// 파일 락은 한 대에서만 유효하다. 지금은 한 대지만 **Postgres로 옮기면 그대로 advisory
// lock으로 갈아 끼울 자리**가 필요하고, 그때 호출부를 안 고치려면 경계가 여기여야 한다.
// AppSetting은 key가 기본키라 `create`가 곧 원자적 compare-and-set이다 — 표를 새로
// 만들지 않아도 된다.
//
// ── 죽은 락을 어떻게 푸는가 ──────────────────────────────────
// 프로세스가 죽으면 행이 남는다. 시간만으로 "오래됐으니 뺏는다"고 하면 **느린 배치를
// 죽은 것으로 오인**해 정확히 막으려던 동시 실행을 만든다. 그래서 도는 동안 락의
// 시각을 계속 갱신하고(HEARTBEAT_MS), 그 갱신이 STALE_MS 넘게 멈춘 것만 뺏는다 —
// 살아 있으면 아무리 오래 걸려도 뺏기지 않는다.

const KEY_PREFIX = 'batch.lock.';

/** 락을 쥔 채 이 간격으로 시각을 갱신한다 — "느린 것"과 "죽은 것"을 가르는 신호 */
export const LOCK_HEARTBEAT_MS = 30_000;

/** 갱신이 이만큼 멈추면 죽은 것으로 보고 뺏는다 (심박의 여러 배여야 안전하다) */
export const LOCK_STALE_MS = 5 * 60_000;

export class BatchLockBusy extends Error {
  constructor(
    readonly name_: string,
    readonly holder: string,
    readonly since: Date,
  ) {
    super(`배치 "${name_}"가 이미 실행 중입니다 (${holder}, ${since.toISOString()} 시작)`);
    this.name = 'BatchLockBusy';
  }
}

interface LockValue {
  holder: string;
  startedAt: string;
  beatAt: string;
}

function parse(raw: string): LockValue | null {
  try {
    const v = JSON.parse(raw) as Partial<LockValue>;
    return v.holder && v.startedAt && v.beatAt ? (v as LockValue) : null;
  } catch {
    return null;
  }
}

/**
 * 배치 하나를 상호배제로 실행한다.
 *
 * 이미 누가 돌고 있으면 **기다리지 않고 던진다** — 배치는 다음 주기에 어차피 다시 돌고,
 * 여기서 기다리면 큐 뒤의 다른 배치까지 함께 밀린다.
 */
export async function withBatchLock<T>(
  prisma: PrismaClient,
  name: string,
  fn: () => Promise<T>,
  now = () => new Date(),
): Promise<T> {
  const key = `${KEY_PREFIX}${name}`;
  const holder = `pid:${process.pid}`;
  const startedAt = now();

  const value = (beatAt: Date): string =>
    JSON.stringify({ holder, startedAt: startedAt.toISOString(), beatAt: beatAt.toISOString() });

  const acquire = async (): Promise<boolean> => {
    try {
      await prisma.appSetting.create({ data: { key, value: value(startedAt) } });
      return true;
    } catch {
      return false;
    }
  };

  if (!(await acquire())) {
    const existing = await prisma.appSetting.findUnique({ where: { key } });
    const held = existing ? parse(existing.value) : null;
    const beatAt = held ? new Date(held.beatAt) : null;
    const dead = !held || !beatAt || now().getTime() - beatAt.getTime() > LOCK_STALE_MS;
    if (!dead) {
      throw new BatchLockBusy(name, held.holder, new Date(held.startedAt));
    }
    // 죽은 락을 뺏는다. **조건부 삭제**라 그 사이 원래 주인이 살아나 갱신했으면
    // 지워지지 않고(value 불일치) 아래 재획득이 실패해 정상적으로 물러난다
    await prisma.appSetting.deleteMany({ where: { key, value: existing?.value } });
    if (!(await acquire())) {
      throw new BatchLockBusy(name, held?.holder ?? 'unknown', new Date(held?.startedAt ?? now()));
    }
    console.warn(`배치 락 회수: ${name} — 이전 주인 ${held?.holder ?? '?'}의 심박이 끊겼습니다`);
  }

  const beat = setInterval(() => {
    void prisma.appSetting
      .update({ where: { key }, data: { value: value(now()) } })
      .catch(() => {}); // 갱신 실패는 치명적이지 않다 — STALE_MS 안에 다시 시도한다
  }, LOCK_HEARTBEAT_MS);
  // 이 타이머가 프로세스 종료를 붙잡으면 안 된다 (CLI 배치가 안 끝난다)
  beat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(beat);
    // **내 락만 지운다** — 회수당한 뒤라면 지금 주인은 남이고, 그 사람 락을 지우면
    // 내가 막으려던 동시 실행을 내가 만든다
    await prisma.appSetting
      .deleteMany({ where: { key, value: { startsWith: `{"holder":"${holder}","startedAt":"${startedAt.toISOString()}"` } } })
      .catch(() => {});
  }
}
