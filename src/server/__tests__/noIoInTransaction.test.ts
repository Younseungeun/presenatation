import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// **트랜잭션 안에서 외부 호출을 하지 않는다** — 이 불변식이 지금 우리를 살리고 있다.
//
// ── 왜 이것이 시험할 만한 성질인가 (2026-08-15 실측) ──────────
// SQLite는 WAL에서도 쓰기를 직렬화한다. 외부 검토가 "그래서 판정 배치가 쓰기 락을 쥔
// 동안 결제가 SQLITE_BUSY로 죽는다 → Postgres는 런칭 전 필수"라고 했고, **메커니즘은
// 맞다.** 그런데 결론은 "배치가 락을 오래 쥔다"를 전제로 하고, 그 전제가 참인지는
// 재면 알 수 있다 (scripts/measureWriteContention.ts, 두 프로세스 실측):
//
//   실제 모양 (트랜잭션 안에 네트워크 없음)
//     판정 쓰기 133건  p50 18ms  p99 24ms   실패 0
//     결제 쓰기 264건  p50 16ms  p99 20ms   **실패 0**   ← 실제의 55배로 압박한 값
//   대조군 (트랜잭션 안에서 16초를 끄는 경우)
//     결제 쓰기   0건  **성공 0 / 실패 2**  ← 검토가 그린 그림이 그대로 재현된다
//
// 즉 무너뜨리는 것은 **엔진이 아니라 트랜잭션 길이**다. 우리 트랜잭션이 18ms인 이유는
// 우연이 아니라 구조다 — 시세 호출(KIS)이 트랜잭션 **밖**에서 끝나고, 안에는 문장
// 배열만 들어간다. 그리고 **배열형 `$transaction`은 그 성질을 문법으로 강제한다**:
// 배열 안에서는 await을 할 수 없어 I/O가 물리적으로 들어갈 자리가 없다.
//
// 인터랙티브 형태(`$transaction(async tx => ...)`)를 쓰는 순간 그 보장이 사라지고,
// 그때는 코드 리뷰가 유일한 방어선이 된다. 그래서 형태 자체를 막는다.
//
// ⚠ 이 시험이 Postgres 전환을 대신하지는 않는다. 다만 **"DB 락 때문에 지금 당장
// 옮겨야 한다"는 진단의 근거**는 이 불변식이 지켜지는 한 성립하지 않는다.
// (전환 뒤에도 트랜잭션 안의 네트워크 호출은 커넥션을 잡아먹는 나쁜 습관이다)

const SERVER_DIR = join(process.cwd(), 'src', 'server');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : tsFiles(p);
    return name.endsWith('.ts') ? [p] : [];
  });
}

describe('트랜잭션 안에 I/O가 들어갈 자리를 만들지 않는다', () => {
  it('src/server에는 인터랙티브 트랜잭션이 없다 — 배열형만 쓴다', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SERVER_DIR)) {
      const src = readFileSync(file, 'utf8');
      // `$transaction(` 바로 뒤에 async 콜백이 오는 형태만 잡는다
      if (/\$transaction\(\s*(async\b|\([^)]*\)\s*=>)/.test(src)) {
        offenders.push(file.replace(process.cwd(), '').replace(/\\/g, '/'));
      }
    }
    expect(
      offenders,
      '인터랙티브 트랜잭션은 안에서 await이 가능해 네트워크 호출이 쓰기 락을 쥔 채 남는다.\n' +
        'SQLite에서는 그 순간 결제 쓰기가 SQLITE_BUSY로 죽는다(scripts/measureWriteContention.ts).\n' +
        '배열형 $transaction([...])을 쓰거나, 외부 호출을 트랜잭션 밖으로 빼세요.',
    ).toEqual([]);
  });
});
