import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// **SQLite의 쓰기-쓰기 경합을 논쟁이 아니라 숫자로 정한다** (2026-08-15).
//
// 외부 검토가 "WAL은 읽기-쓰기만 풀 뿐 쓰기-쓰기는 여전히 직렬이라, 판정 배치가 쓰기
// 락을 쥔 동안 결제가 SQLITE_BUSY로 죽는다 → Postgres는 런칭 전 P0"라고 했다.
// **메커니즘은 맞다.** SQLite는 WAL에서도 동시에 두 트랜잭션이 쓰지 못한다.
//
// 그런데 그 결론은 **"배치가 쓰기 락을 오래 쥔다"**를 전제로 한다. 그 전제가 우리
// 코드에서 참인지는 읽어서 알 수 있고, 얼마나 참인지는 재야 안다:
//
//   · 시세 호출(KIS)은 트랜잭션 **밖**이다 (judgmentBatch: runJudgmentFromRegistry →
//     scoreJudgedCard → buildJudgmentWrites → $transaction). 네트워크는 락 안에 없다
//   · 트랜잭션은 **카드 한 장 단위**의 배열형이다 (인터랙티브 트랜잭션이 아니라
//     문장 6개 남짓을 한 번에 보낸다). 회차 전체를 묶지 않는다
//
// 그래서 이 스크립트는 두 프로세스를 실제로 띄워 다음을 잰다:
//   ① 판정 쓰기 트랜잭션이 락을 쥐는 시간 (p50/p99)
//   ② 그동안 들어온 결제성 쓰기의 지연과 **실패 건수**
//   ③ 대조군: 트랜잭션 안에서 일부러 오래 끄는 경우 — 검토가 그린 그림이 실제로
//      재현되는지, 그리고 그때 무너지는 것이 **엔진인지 트랜잭션 길이인지**
//
// 쓰는 법:  npx tsx scripts/measureWriteContention.ts [--slow-ms 8000]
//
// 남기는 이유: Postgres 전환은 큰 작업이라 "누가 그렇다더라"로 결정하면 안 된다.
// 전환 뒤에도 같은 스크립트로 재서 **좋아졌다는 근거**를 남길 수 있어야 한다.

const TAG = '[write-contention]';
const DURATION_MS = 6_000;

/** 판정 쓰기 한 건의 모양 — buildJudgmentWrites가 내보내는 문장 수와 맞춘다 */
function judgmentLikeWrites(prisma: PrismaClient, slowMs: number) {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    userId: `${TAG}`,
    type: 'BENCH',
    title: `bench-${i}`,
    body: 'x',
  }));
  const writes = rows.map((data) => prisma.notification.create({ data }));
  if (slowMs > 0) {
    // 트랜잭션 **안에서** 일부러 시간을 끈다 — 재귀 CTE로 CPU를 태운다.
    // 앞선 create들이 이미 썼으므로 이 시점에 쓰기 락은 우리 것이다
    const n = slowMs * 20_000; // 대략적인 눈금 (정확할 필요 없다 — 길게 끌기만 하면 된다)
    writes.push(
      prisma.$queryRawUnsafe(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${n}) SELECT count(*) AS n FROM c`,
      ) as never,
    );
  }
  return writes;
}

/** 결제 쓰기 한 건의 모양 — purchaseService는 guard + create 둘을 한 트랜잭션에 넣는다 */
function purchaseLikeWrites(prisma: PrismaClient) {
  return [
    prisma.notification.create({
      data: { userId: TAG, type: 'BENCH_BUY', title: 'guard', body: 'x' },
    }),
    prisma.notification.create({
      data: { userId: TAG, type: 'BENCH_BUY', title: 'create', body: 'x' },
    }),
  ];
}

function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, p50: 0, p99: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { n: s.length, p50: at(0.5), p99: at(0.99), max: s[s.length - 1] };
}

async function runRole(role: 'batch' | 'web', slowMs: number) {
  const prisma = new PrismaClient();
  const latencies: number[] = [];
  const errors: string[] = [];
  const until = Date.now() + DURATION_MS;

  while (Date.now() < until) {
    const t0 = Date.now();
    try {
      await prisma.$transaction(
        role === 'batch' ? judgmentLikeWrites(prisma, slowMs) : purchaseLikeWrites(prisma),
      );
      latencies.push(Date.now() - t0);
    } catch (e) {
      errors.push(e instanceof Error ? e.message.split('\n')[0] : String(e));
    }
    // 배치는 카드마다 시세를 부르므로 쓰기 사이에 최소 1.1초가 비어 있다.
    // 그 사실을 지우고 재면 실제보다 훨씬 나쁜 그림이 나온다 — 다만 여기서는
    // **최악을 보려고** 간격을 20ms로 좁힌다(실제의 55배 압박)
    await new Promise((r) => setTimeout(r, role === 'batch' ? 20 : 5));
  }

  await prisma.$disconnect();
  process.stdout.write(JSON.stringify({ role, latencies, errors }) + '\n');
}

function child(role: 'batch' | 'web', slowMs: number): Promise<{ latencies: number[]; errors: string[] }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.argv[1], '--role', role, '--slow-ms', String(slowMs)], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', () => {
      const line = out.trim().split('\n').pop() ?? '{}';
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`자식 프로세스 출력 해석 실패: ${out.slice(0, 200)}`));
      }
    });
  });
}

async function scenario(label: string, slowMs: number) {
  const [batch, web] = await Promise.all([child('batch', slowMs), child('web', slowMs)]);
  const b = stats(batch.latencies);
  const w = stats(web.latencies);
  console.log(`\n── ${label} ───────────────────────────────`);
  console.log(`  판정 쓰기  ${b.n}건  p50 ${b.p50}ms  p99 ${b.p99}ms  max ${b.max}ms  실패 ${batch.errors.length}`);
  console.log(`  결제 쓰기  ${w.n}건  p50 ${w.p50}ms  p99 ${w.p99}ms  max ${w.max}ms  실패 ${web.errors.length}`);
  if (web.errors.length > 0) console.log(`  ⚠ 결제 쓰기 실패 사유: ${web.errors[0]}`);
  return { failed: web.errors.length, succeeded: w.n };
}

async function main() {
  const roleIdx = process.argv.indexOf('--role');
  const slowIdx = process.argv.indexOf('--slow-ms');
  const slowMs = slowIdx >= 0 ? Number(process.argv[slowIdx + 1]) : 0;

  if (roleIdx >= 0) {
    await runRole(process.argv[roleIdx + 1] as 'batch' | 'web', slowMs);
    return;
  }

  console.log(`대상: ${process.env.DATABASE_URL}`);
  const prisma = new PrismaClient();
  console.log('저널 모드:', JSON.stringify(await prisma.$queryRawUnsafe('PRAGMA journal_mode')));
  console.log('busy_timeout:', JSON.stringify(await prisma.$queryRawUnsafe('SELECT CAST(timeout AS TEXT) AS ms FROM pragma_busy_timeout')));
  await prisma.$disconnect();

  // ① 실제 모양: 트랜잭션 안에 I/O가 없다
  const real = await scenario('실제 모양 (트랜잭션 안에 네트워크 없음)', 0);
  // ② 대조군: 검토가 그린 그림 — 트랜잭션이 오래 걸리는 경우
  const slow = await scenario('대조군 (트랜잭션 안에서 오래 끄는 경우)', 4_000);

  console.log('\n── 결론 ─────────────────────────────────');
  if (real.failed === 0 && slow.failed > 0) {
    console.log('  쓰기-쓰기 경합은 실재한다. 다만 무너뜨리는 것은 **엔진이 아니라 트랜잭션 길이**다.');
    console.log('  우리 트랜잭션에는 네트워크 호출이 없고 카드 한 장 단위라 실제 모양에서는 실패 0,');
    console.log('  트랜잭션이 busy_timeout을 넘게 길어지는 순간 결제가 통째로 죽는다.');
    console.log('  → 지켜야 하는 불변식: **트랜잭션 안에서 외부 호출을 하지 않는다** (checkNoIoInTransaction).');
  } else if (real.failed > 0) {
    console.log('  ⚠ 실제 모양에서도 결제 쓰기가 실패했다 — Postgres 전환이 급하다.');
  } else {
    console.log('  대조군에서도 실패가 없다 — busy_timeout이 흡수했다. --slow-ms를 올려 다시 재라.');
  }

  const cleanup = new PrismaClient();
  const { count } = await cleanup.notification.deleteMany({ where: { userId: TAG } });
  console.log(`\n정리: 시험용 행 ${count}건 삭제`);
  await cleanup.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
