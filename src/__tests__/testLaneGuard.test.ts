import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// **DB를 쓰는 시험은 `*.db.test.ts` 여야 한다** (2026-08-23 실제 플레이크 뒤 추가).
//
// ── 왜 이름이 중요한가 ──────────────────────────────────────
// vitest.config.ts 가 갈래를 **파일 이름으로** 가른다. `db` 갈래만
// `fileParallelism: false` 라, 파일마다 `npx prisma migrate deploy` 를 부르는
// 시험들이 서로 밟지 않는다. 이름이 틀리면 그 시험은 **병렬로 도는 `unit` 갈래**에
// 들어가고, 거기서 db 갈래와 동시에 prisma CLI 를 두드린다.
//
// ── 실제로 일어난 일 ────────────────────────────────────────
// `schemaBootCheck.test.ts` 가 `createTestDb` 를 부르면서 이름은 `.db` 가 아니었다.
// 두 세션이 각각 며칠 간격으로 같은 간헐 실패를 만났고(`P3009`·스키마 없음), 둘 다
// **마이그레이션이 깨진 줄 알고** 그쪽을 먼저 뒤졌다. 원인은 파일 이름 하나였다.
//
// 설정 주석은 *"새로 쓰는 사람이 옆 파일을 복사하면 규칙이 저절로 따라온다"* 고
// 적어 두었는데, 옆 파일을 복사하지 않으면 따라오지 않는다. **간헐 실패는 원인을
// 스스로 말하지 않으므로**(빨간 줄이 엉뚱한 곳을 가리킨다) 사람 대신 시험이 본다.

const SRC = path.join(process.cwd(), 'src');

/** DB 갈래에 있어야 하는가 — 임시 DB를 만들거나 Prisma 클라이언트를 직접 세우는가 */
function touchesDb(src: string): boolean {
  return /createTestDb|new PrismaClient/.test(src);
}

function testFiles(dir = SRC, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) testFiles(full, out);
    else if (e.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('시험 갈래', () => {
  const files = testFiles();

  it('찾을 시험이 있다 — 경로가 바뀌면 이 시험이 조용히 0건을 통과한다', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('**DB를 쓰는 시험은 전부 `*.db.test.ts` 다** — 아니면 병렬 갈래에서 prisma CLI 가 겹친다', () => {
    const strays = files
      .filter((f) => !f.endsWith('.db.test.ts'))
      // **자기 자신은 뺀다** — 찾는 낱말을 본문에 적어 두었으니 스스로에게 걸린다.
      // 낱말을 쪼개 숨길 수도 있지만(`'new Prisma' + 'Client'`) 그러면 다음 사람이
      // 이 정규식을 못 찾는다. 예외를 한 줄로 드러내는 편이 정직하다
      .filter((f) => f !== __filename)
      .filter((f) => touchesDb(readFileSync(f, 'utf8')))
      .map((f) => path.relative(process.cwd(), f).replace(/\\/g, '/'));

    expect(
      strays,
      `이 시험들은 DB를 쓰는데 이름이 \`.db.test.ts\` 가 아닙니다. 병렬로 도는 \`unit\` ` +
        `갈래에 들어가 \`prisma migrate deploy\` 가 서로를 밟고, 그 결과는 **엉뚱한 곳을 ` +
        `가리키는 간헐 실패**입니다(P3009·스키마 없음). 파일 이름 뒤에 \`.db\` 를 붙이십시오:\n` +
        strays.map((s) => `  - ${s}`).join('\n'),
    ).toEqual([]);
  });
});
