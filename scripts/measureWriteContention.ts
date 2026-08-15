import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

// **SQLite의 쓰기-쓰기 경합을 논쟁이 아니라 숫자로 정한다** (2026-08-15).
//
// 외부 검토가 "WAL은 읽기-쓰기만 풀 뿐 쓰기-쓰기는 여전히 직렬이라, 판정 배치가 쓰기
// 락을 쥔 동안 결제가 SQLITE_BUSY로 죽는다 → Postgres는 런칭 전 P0"라고 했다.
// **메커니즘은 맞다.** SQLite는 WAL에서도 동시에 두 트랜잭션이 쓰지 못한다.
//
// 그 결론은 **"배치가 쓰기 락을 오래 쥔다"**를 전제로 하고, 그 전제는 잴 수 있다:
//   · 시세 호출(KIS)은 트랜잭션 **밖**이다 (judgmentBatch: 조회 → 채점 → $transaction)
//   · 트랜잭션은 **카드 한 장 단위**의 배열형이라 안에서 await을 할 수 없다
//
// 2차 검토가 세 가지를 더 짚었고, 그중 둘은 **이 스크립트가 이미 재고 있었다**:
//   ① "단일 프로세스만 쟀다" → **아니다.** 처음부터 child_process로 **별도 OS 프로세스**
//      둘을 띄운다. 아래 SWEEP이 그 수를 늘려 어디서 깨지는지까지 본다
//   ② "WAL 체크포인트가 EXCLUSIVE 락을 잡아 수백 ms~수 초를 막는다" → 기본
//      auto-checkpoint는 **PASSIVE**라 쓰는 쪽을 막지 않고 물러난다. 그래도 말로
//      끝내지 않고 WAL 파일 크기와 체크포인트 결과를 함께 찍는다
//   ③ "pm2 클러스터·다중 파드로 늘리면 깨진다" → **동의한다.** 그래서 몇에서 깨지는지를
//      재는 것이 이 스크립트의 본론이 됐다. 그 수가 곧 Postgres 전환의 트리거다
//
// 쓰는 법:  npm run measure:contention
//
// 남기는 이유: Postgres 전환은 큰 작업이라 "누가 그렇다더라"로 결정하면 안 된다.
// 전환 뒤에도 같은 스크립트로 재서 **좋아졌다는 근거**를 남길 수 있어야 한다.

const TAG = '[write-contention]';
const DURATION_MS = 6_000;

/** 웹 서버를 몇 벌로 늘려 볼 것인가 — pm2 클러스터·다중 파드가 이 축이다 */
const WEB_WRITER_SWEEP = [1, 2, 4, 8];

/** 판정 쓰기 한 건의 모양 — buildJudgmentWrites가 내보내는 문장 수와 맞춘다 */
function judgmentLikeWrites(prisma: PrismaClient, slowMs: number) {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    userId: TAG,
    type: 'BENCH',
    title: `bench-${i}`,
    body: 'x',
  }));
  const writes = rows.map((data) => prisma.notification.create({ data }));
  if (slowMs > 0) {
    // 트랜잭션 **안에서** 일부러 시간을 끈다 — 재귀 CTE로 CPU를 태운다.
    // 앞선 create들이 이미 썼으므로 이 시점에 쓰기 락은 우리 것이다
    const n = slowMs * 20_000;
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
      const msg = e instanceof Error ? `${(e as { code?: string }).code ?? ''} ${e.message.split('\n').find((l) => l.trim()) ?? ''}` : String(e);
      errors.push(msg.trim() || 'unknown');
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

function walBytes(): number {
  const url = (process.env.DATABASE_URL ?? '').replace(/^file:/, '');
  const path = url.startsWith('.') ? `prisma/${url.slice(2)}` : url;
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return -1;
  }
}

async function scenario(label: string, webWriters: number, slowMs: number) {
  // **WAL은 도는 동안에만 존재한다** — 마지막 연결이 닫히면 SQLite가 체크포인트하고
  // 파일을 지운다. 그래서 시작·끝이 아니라 **한창일 때** 재야 뜻이 있다.
  // 이 값이 폭주하지 않는 것이 곧 "auto-checkpoint가 돌고 있다"의 증거다
  // (기본 auto-checkpoint는 PASSIVE라 쓰는 쪽을 막지 않고 물러난다)
  let walPeak = 0;
  const sampler = setInterval(() => {
    walPeak = Math.max(walPeak, walBytes());
  }, 250);

  const results = await Promise.all([
    child('batch', slowMs),
    ...Array.from({ length: webWriters }, () => child('web', slowMs)),
  ]);
  clearInterval(sampler);
  const [batch, ...webs] = results;
  const b = stats(batch.latencies);
  const w = stats(webs.flatMap((x) => x.latencies));
  const webErrors = webs.flatMap((x) => x.errors);

  console.log(`\n── ${label} ───────────────────────────────`);
  console.log(`  판정 쓰기  ${b.n}건  p50 ${b.p50}ms  p99 ${b.p99}ms  max ${b.max}ms  실패 ${batch.errors.length}`);
  console.log(`  결제 쓰기  ${w.n}건  p50 ${w.p50}ms  p99 ${w.p99}ms  max ${w.max}ms  실패 ${webErrors.length}`);
  console.log(`  WAL 최대   ${(walPeak / 1024).toFixed(0)}KB (auto-checkpoint가 돌고 있으면 여기서 멈춘다)`);
  if (webErrors.length > 0) console.log(`  ⚠ 결제 쓰기 실패 사유: ${webErrors[0]}`);
  return { failed: webErrors.length, succeeded: w.n, p99: w.p99, max: w.max };
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
  // PRAGMA는 정수를 BigInt로 돌려줘 JSON.stringify가 그대로는 못 삼킨다
  const q = (sql: string) =>
    prisma
      .$queryRawUnsafe(sql)
      .then((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  console.log('저널 모드:', await q('PRAGMA journal_mode'));
  console.log('busy_timeout:', await q('SELECT CAST(timeout AS TEXT) AS ms FROM pragma_busy_timeout'));
  // **체크포인트 주장의 근거를 여기서 본다.** 기본 auto-checkpoint는 PASSIVE라
  // 쓰는 쪽을 막지 않고 물러난다 — 아래 WAL 크기가 폭주하지 않는 것이 그 증거다
  console.log('wal_autocheckpoint(페이지):', await q('PRAGMA wal_autocheckpoint'));
  await prisma.$disconnect();

  // ── ① 웹 프로세스 수를 늘려 가며 어디서 깨지는지 본다 ──
  // pm2 클러스터·다중 파드가 정확히 이 축이다. **몇에서 깨지는가가 곧 전환 트리거다**
  const cliff: { writers: number; failed: number; p99: number }[] = [];
  for (const writers of WEB_WRITER_SWEEP) {
    const r = await scenario(`웹 쓰기 프로세스 ${writers}벌 (트랜잭션 안에 네트워크 없음)`, writers, 0);
    cliff.push({ writers, failed: r.failed, p99: r.p99 });
  }

  // ── ② 대조군: 트랜잭션이 길어지는 경우 ──
  const slow = await scenario('대조군 (트랜잭션 안에서 오래 끄는 경우)', 1, 4_000);

  console.log('\n── 결론 ─────────────────────────────────');
  console.log('  웹 프로세스 수별 결제 쓰기:');
  for (const c of cliff) {
    console.log(`    ${String(c.writers).padStart(2)}벌 → p99 ${String(c.p99).padStart(5)}ms · 실패 ${c.failed}건`);
  }

  // **깨지는 지점은 오류가 아니라 지연이다.** busy_timeout 5초가 실패를 흡수하는 동안
  // p99가 먼저 사람 눈에 보이는 값으로 올라간다 — 결제 화면에서 1초는 이미 사고다
  const P99_BUDGET_MS = 300;
  const first = cliff[0]?.p99 ?? 0;
  const overBudget = cliff.find((c) => c.p99 > P99_BUDGET_MS);
  const failing = cliff.find((c) => c.failed > 0);
  if (failing) {
    console.log(`  → **${failing.writers}벌에서 오류가 난다.**`);
  }
  if (overBudget) {
    console.log(
      `  → **${overBudget.writers}벌에서 p99가 ${overBudget.p99}ms** (1벌 대비 ${(overBudget.p99 / Math.max(1, first)).toFixed(0)}배).\n` +
        `     실패는 busy_timeout이 흡수하지만 그 전에 **지연이 먼저 무너진다** — 전환 트리거는 여기다.\n` +
        `     지금은 웹이 한 프로세스라 안전 구간이고, pm2 클러스터·다중 파드로 늘리는 순간 넘는다.`,
    );
  } else {
    console.log(`  → ${WEB_WRITER_SWEEP.at(-1)}벌까지 p99 ${P99_BUDGET_MS}ms 이내. 이 구간에서는 엔진이 병목이 아니다.`);
  }
  if (slow.failed > 0 && slow.succeeded === 0) {
    console.log('  대조군은 전멸했다 — 무너뜨리는 것은 **엔진이 아니라 트랜잭션 길이**다.');
    console.log('  → 지켜야 하는 불변식: 트랜잭션 안에서 외부 호출을 하지 않는다 (noIoInTransaction.test.ts).');
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
