import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { BatchLockBusy, LOCK_STALE_MS, withBatchLock } from '../batchLock';

// **같은 배치가 두 벌 동시에 돌지 않게 한다.**
//
// 외부 검토는 "배치가 죽고 재실행되면 이중 지불"을 걱정했는데 그건 우리 구조에서
// 일어나지 않는다 — 배치는 지시서만 쓰고 실제 송금은 운영자 콘솔에서만 나가며,
// 그 경로에 멱등키가 걸려 있다(judgmentBatch.db.test.ts가 순차 재실행을 고정한다).
//
// 진짜 문제는 **동시** 실행이다. KIS 토큰이 분당 1회라 두 벌이 겹치면 한쪽이 통째로
// 죽고, 같은 카드를 집은 쪽은 unique 제약 오류를 "우리 버그"로 보고해 경보가
// 거짓말을 한다. 그 통로는 두 스케줄러가 아니라 **스케줄러 + 손으로 돌린 batch:judge**다.

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createTestDb('batch-lock-');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('배치 상호배제', () => {
  it('한 번에 하나만 돈다 — 두 번째는 기다리지 않고 물러난다', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let rejected = 0;

    const job = () =>
      withBatchLock(prisma, 'judge', async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 120));
        running--;
      }).catch((e) => {
        if (e instanceof BatchLockBusy) rejected++;
        else throw e;
      });

    await Promise.all([job(), job(), job()]);

    expect(maxConcurrent).toBe(1);
    expect(rejected).toBe(2);
  });

  it('끝나면 락을 놓는다 — 다음 회차가 정상적으로 돈다', async () => {
    let ran = false;
    await withBatchLock(prisma, 'judge', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    // 락 행이 남아 있으면 이 두 번째 호출이 BatchLockBusy로 죽는다
    await expect(withBatchLock(prisma, 'judge', async () => 'ok')).resolves.toBe('ok');
  });

  it('배치가 다르면 서로 막지 않는다', async () => {
    await withBatchLock(prisma, 'judge', async () => {
      await expect(withBatchLock(prisma, 'reached', async () => 'ok')).resolves.toBe('ok');
    });
  });

  // 프로세스가 죽으면 행이 남는다. **시간만 보고 뺏으면** 느린 배치를 죽은 것으로
  // 오인해 정확히 막으려던 동시 실행을 만든다 — 그래서 도는 동안 갱신되는 심박을 본다
  it('심박이 끊긴 락은 회수한다 — 죽은 프로세스가 배치를 영구히 잠그면 안 된다', async () => {
    const dead = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await prisma.appSetting.create({ data: { key: 'batch.lock.season', value: 'pid:99999:dead' } });
    // updatedAt이 곧 심박이다 — @updatedAt은 직접 못 쓰므로 raw로 밀어 넣는다
    await prisma.$executeRawUnsafe(
      'UPDATE AppSetting SET updatedAt = ? WHERE key = ?',
      dead.toISOString(),
      'batch.lock.season',
    );

    await expect(withBatchLock(prisma, 'season', async () => 'ok')).resolves.toBe('ok');
    // 회수한 쪽이 끝나면서 자기 락을 지운다
    expect(await prisma.appSetting.findUnique({ where: { key: 'batch.lock.season' } })).toBeNull();
  });

  // 살아 있는 배치는 아무리 오래 걸려도 뺏기지 않는다 — 그게 "느린 것"과 "죽은 것"을
  // 시간이 아니라 심박으로 가르는 이유다
  it('심박이 도는 락은 오래돼도 뺏기지 않는다', async () => {
    // 방금 자격 검사를 통과한 락 — updatedAt이 지금이다
    await prisma.appSetting.create({ data: { key: 'batch.lock.quotes', value: 'pid:12345:alive' } });

    await expect(withBatchLock(prisma, 'quotes', async () => 'ok')).rejects.toBeInstanceOf(
      BatchLockBusy,
    );
    await prisma.appSetting.delete({ where: { key: 'batch.lock.quotes' } });
  });

  it('본문이 던져도 락은 풀린다 — 실패가 배치를 영구히 잠그면 안 된다', async () => {
    await expect(
      withBatchLock(prisma, 'judge', async () => {
        throw new Error('시세 조회 실패');
      }),
    ).rejects.toThrow('시세 조회 실패');

    await expect(withBatchLock(prisma, 'judge', async () => 'ok')).resolves.toBe('ok');
  });

  // ── 펜싱 토큰 — 심박만으로는 못 막는 것 ────────────────────
  //
  // **스플릿 브레인**: A가 GC 파즈·OS 하이로드로 멈춘 사이 B가 락을 회수하면, A는
  // 자기가 락을 잃은 줄 모르고 깨어나 남은 쓰기를 계속한다. 회수 조건을 아무리
  // 조여도 이 창은 원리적으로 안 닫힌다 — 회수하는 쪽은 상대가 죽었는지 느린지
  // 구별할 수 없기 때문이다. 닫는 방법은 **쓰기마다 자격을 다시 묻는 것**뿐이다.

  it('락을 뺏기면 그 뒤의 쓰기가 통째로 롤백된다 — 깨어난 프로세스는 한 줄도 못 쓴다', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'batch.lock.fenced' } });

    let stolenFence: (() => unknown) | null = null;
    await withBatchLock(prisma, 'fenced', async (lock) => {
      stolenFence = lock.fence;
      // **여기서 A가 멈춘 셈** — 그 사이 B가 락을 가져간다
      await prisma.appSetting.update({
        where: { key: 'batch.lock.fenced' },
        data: { value: 'pid:other:stole-it' },
      });
    });

    // A가 깨어나 쓰기를 시도한다. 자격 검사가 첫 문장이라 트랜잭션 전체가 죽는다
    await expect(
      prisma.$transaction([
        (stolenFence as unknown as () => never)(),
        prisma.notification.create({
          data: { userId: 'ghost', type: 'X', title: '유령 쓰기', body: 'x' },
        }),
      ]),
    ).rejects.toMatchObject({ code: 'P2025' });

    // **가장 중요한 확인** — 뒤따르던 쓰기가 하나도 안 남았다
    expect(await prisma.notification.count({ where: { userId: 'ghost' } })).toBe(0);
    await prisma.appSetting.deleteMany({ where: { key: 'batch.lock.fenced' } });
  });

  it('락을 쥐고 있으면 자격 검사가 통과하고, 그것이 곧 심박이다', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'batch.lock.beat' } });
    await withBatchLock(prisma, 'beat', async (lock) => {
      const before = await prisma.appSetting.findUniqueOrThrow({
        where: { key: 'batch.lock.beat' },
      });
      await new Promise((r) => setTimeout(r, 20));
      await prisma.$transaction([lock.fence()]);
      const after = await prisma.appSetting.findUniqueOrThrow({
        where: { key: 'batch.lock.beat' },
      });
      // 값은 그대로(토큰은 불변), updatedAt만 밀린다 — 따로 심박을 뛸 필요가 없다
      expect(after.value).toBe(before.value);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });
  });
});
