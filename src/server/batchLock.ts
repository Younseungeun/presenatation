import type { Prisma, PrismaClient } from '@prisma/client';

// **같은 배치가 두 벌 동시에 돌지 않게 한다** (2026-08-15).
//
// ── 무엇이 진짜 위험인가 (외부 검토 반박) ────────────────────
// 검토가 "배치가 중간에 죽고 재실행되면 이미 정산된 건이 다시 나가 **이중 지불**이
// 난다"고 했다. **우리 구조에서는 일어나지 않는다** — 두 겹으로 막혀 있다:
//
//   ① 배치는 **돈을 움직이지 않는다.** Settlement는 지시서일 뿐이고 실제 PG 취소·
//      지급은 운영자 콘솔에서만 실행된다(refundExecutedAt·payoutExecutedAt 가드 +
//      RefundAttempt의 멱등키). 배치를 백 번 돌려도 돈은 한 번도 안 나간다
//   ② 배치는 `judgment: null`인 카드만 집고 `Judgment.predictionCardId`가 unique다
//      (judgmentBatch.db.test.ts "멱등성: 배치 재실행해도 중복 판정·중복 정산 없음")
//
// **그런데 동시 실행은 다른 이유로 실제 문제다.** KIS 토큰이 분당 1회라 두 벌이 겹치면
// 한쪽이 통째로 죽고, 같은 카드를 집은 쪽은 unique 오류를 받아 그것이 "우리 버그"로
// 분류된 운영자 알림으로 뜬다 — 돈은 안 새지만 경보가 거짓말을 한다. 통로는 두
// 스케줄러가 아니라 **스케줄러 + 손으로 돌린 `npm run batch:judge`**다.
//
// ── 심박만으로는 부족하다 — 펜싱 토큰 (2026-08-15 2차 검토 반영) ──
// 첫 구현은 "심박이 끊긴 락은 회수한다"까지였다. 검토가 **스플릿 브레인**을 지적했고
// 맞는 지적이다: A가 GC 파즈·OS 하이로드로 STALE_MS를 넘겨 멈추면 B가 락을 회수하는데,
// **A는 자기가 락을 잃은 줄 모르고 깨어나 남은 쓰기를 계속한다.** 회수 조건을 아무리
// 조여도 이 창은 원리적으로 닫히지 않는다 — 회수하는 쪽은 상대가 죽었는지 느린지
// 구별할 방법이 없기 때문이다.
//
// 닫는 방법은 회수 판정을 정교하게 만드는 것이 아니라 **쓰기마다 자격을 다시 묻는 것**이다:
//
//     prisma.appSetting.update({ where: { key, value: 토큰 }, data: { value: 토큰 } })
//
// 이 문장을 **각 카드 트랜잭션의 첫 줄**에 넣는다. 락을 뺏겼으면 값이 안 맞아
// Prisma가 P2025로 던지고, 배열형 트랜잭션이므로 **그 카드의 쓰기 전체가 롤백된다.**
// 깨어난 A는 한 장도 쓰지 못한다.
//
// 토큰이 **불변**이어야 이 비교가 성립한다. 그래서 값에는 토큰만 넣고 심박은
// `updatedAt`(@updatedAt)에 맡긴다 — Prisma는 같은 값으로 update해도 updatedAt을
// 갱신하므로, **자격 검사가 곧 심박**이 된다(따로 뛸 필요조차 없다).
//
// ── 왜 파일 락이 아니라 DB 락인가 ────────────────────────────
// 파일 락은 한 대에서만 유효하다. Postgres로 옮기면 이 자리가 그대로 advisory lock이
// 되고, 그때 호출부를 안 고치려면 경계가 여기여야 한다. AppSetting은 key가 기본키라
// `create`가 곧 원자적 compare-and-set이다 — 표를 새로 만들지 않아도 된다.

const KEY_PREFIX = 'batch.lock.';

/** 자격 검사(=심박)가 이만큼 멈추면 죽은 것으로 보고 회수한다 */
export const LOCK_STALE_MS = 5 * 60_000;

/**
 * 자격 검사가 없는 구간이 길어질 때를 위한 보조 심박.
 *
 * 판정 배치는 카드마다 트랜잭션을 쓰므로 자격 검사가 계속 도는데, 시세가 전부 이월돼
 * **한 장도 안 쓰는 회차**면 그 사이 심박이 끊긴다. 그때 남이 락을 가져가면 다음 카드의
 * 자격 검사가 실패해 안전하게 멈추긴 하지만, 애초에 살아 있는 배치를 뺏기지 않는 편이 낫다.
 */
export const LOCK_HEARTBEAT_MS = 30_000;

export class BatchLockBusy extends Error {
  constructor(
    readonly lockName: string,
    readonly holder: string,
    readonly since: Date,
  ) {
    super(`배치 "${lockName}"가 이미 실행 중입니다 (${holder}, ${since.toISOString()} 갱신)`);
    this.name = 'BatchLockBusy';
  }
}

/**
 * 락을 쥔 동안 배치가 들고 다니는 자격 증명.
 *
 * `fence()`를 **모든 쓰기 트랜잭션의 첫 문장**으로 넣으면 그 트랜잭션은 "내가 아직
 * 락 주인일 때만" 커밋된다. 넣지 않으면 스플릿 브레인이 그대로 열린다.
 */
export interface BatchFence {
  token: string;
  fence: () => Prisma.PrismaPromise<unknown>;
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
  fn: (fence: BatchFence) => Promise<T>,
  now = () => new Date(),
): Promise<T> {
  const key = `${KEY_PREFIX}${name}`;
  // 토큰은 **잡는 순간 정해지고 끝까지 안 바뀐다** — 바뀌면 자격 검사의 비교 대상이
  // 흔들려 펜싱이 성립하지 않는다. 프로세스가 재시작해도 겹치지 않도록 시각을 섞는다
  const token = `pid:${process.pid}:${now().getTime()}:${Math.random().toString(36).slice(2, 8)}`;

  const acquire = async (): Promise<boolean> => {
    try {
      await prisma.appSetting.create({ data: { key, value: token } });
      return true;
    } catch {
      return false;
    }
  };

  if (!(await acquire())) {
    const existing = await prisma.appSetting.findUnique({ where: { key } });
    const beatAt = existing?.updatedAt ?? null;
    const dead = !existing || !beatAt || now().getTime() - beatAt.getTime() > LOCK_STALE_MS;
    if (!dead) {
      throw new BatchLockBusy(name, existing.value, beatAt);
    }
    // 죽은 락을 회수한다. **조건부 삭제**라 그 사이 원래 주인이 자격 검사를 한 번이라도
    // 통과했으면(= 값이 그대로여도 updatedAt이 갱신됐으면) 아래 재획득이 이기고,
    // 설령 둘 다 통과해도 **A의 다음 쓰기가 자격 검사에서 막힌다** — 그게 펜싱이다
    await prisma.appSetting.deleteMany({ where: { key, value: existing?.value } });
    if (!(await acquire())) {
      throw new BatchLockBusy(name, existing?.value ?? 'unknown', beatAt ?? now());
    }
    console.warn(`배치 락 회수: ${name} — 이전 주인 ${existing?.value ?? '?'}의 자격 검사가 끊겼습니다`);
  }

  const fence: BatchFence = {
    token,
    // **같은 값으로 덮어쓴다.** 값이 안 맞으면 P2025로 던지고(락을 뺏겼다),
    // 맞으면 updatedAt이 갱신돼 심박까지 겸한다
    fence: () => prisma.appSetting.update({ where: { key, value: token }, data: { value: token } }),
  };

  // 쓰기가 뜸한 회차를 위한 보조 심박 — 자격 검사와 같은 문장이라 뺏긴 뒤에는 조용히 실패한다
  const beat = setInterval(() => {
    void fence.fence().catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  beat.unref?.();

  try {
    return await fn(fence);
  } finally {
    clearInterval(beat);
    // **내 락만 지운다** — 회수당한 뒤라면 지금 주인은 남이고, 그 사람 락을 지우면
    // 내가 막으려던 동시 실행을 내가 만든다
    await prisma.appSetting.deleteMany({ where: { key, value: token } }).catch(() => {});
  }
}
