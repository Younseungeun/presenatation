import { readdirSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { REQUIRED_SCHEMA, assertSchemaPresent } from '../schemaBootCheck';

describe('schemaBootCheck — 마이그레이션 기록이 아니라 실체를 본다', () => {
  let migrated: PrismaClient;
  let empty: PrismaClient;
  beforeAll(() => {
    migrated = createTestDb('schema-ok-');
    // 마이그레이션을 한 번도 안 돈 빈 파일 — "기록만 있고 표는 없는" 사고의 극단형
    const dir = mkdtempSync(path.join(tmpdir(), 'schema-empty-'));
    empty = new PrismaClient({ datasourceUrl: `file:${path.join(dir, 'e.db')}` });
  });
  afterAll(async () => {
    await migrated.$disconnect();
    await empty.$disconnect();
  });

  it('마이그레이션이 실제로 돈 DB 는 통과한다', async () => {
    await expect(assertSchemaPresent(migrated)).resolves.toBeUndefined();
  });

  it('표가 없으면 전부 모아 한 번에 던진다', async () => {
    const err = await assertSchemaPresent(empty).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain(`(${REQUIRED_SCHEMA.length}건)`);
    expect(msg).toContain('표 "LearnedPhraseHit" 이 없습니다');
    expect(msg).toContain('표 "ComplianceReview" 이 없습니다');
  });

  it('표는 있는데 칸이 없으면 칸 이름으로 던진다', async () => {
    await expect(
      assertSchemaPresent(migrated, [{ table: 'ComplianceReview', columns: ['없는칸'] }]),
    ).rejects.toThrow('칸 "없는칸" 이 없습니다');
  });

  // ── 소스 스캔 래칫 ──────────────────────────────────────────────
  // raw SQL 로 닿는 표가 REQUIRED_SCHEMA 에 빠지면 여기서 깨진다. Prisma 는 raw 문자열
  // 속 표 이름을 검사하지 않으므로, 이 목록이 낡는 순간 부팅 검사는 구멍이 된다.
  it('raw SQL 이 닿는 모든 표가 REQUIRED_SCHEMA 에 있다', () => {
    const roots = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'app')];
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+"([A-Za-z_]+)"/g)) {
          if (m[1] !== '_prisma_migrations') found.add(m[1]);
        }
      }
    };
    for (const r of roots) walk(r);
    const listed = new Set(REQUIRED_SCHEMA.map((r) => r.table));
    const missing = [...found].filter((t) => !listed.has(t)).sort();
    expect(missing, `raw SQL 이 닿는데 REQUIRED_SCHEMA 에 없는 표: ${missing.join(', ')}`).toEqual([]);
  });
});
