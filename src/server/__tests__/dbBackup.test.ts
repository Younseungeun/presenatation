import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveSqlitePath } from '../dbBackup';

// 백업 경로 해석 — 여기가 틀리면 **없는 파일을 백업했다고 보고**하거나
// 다른 파일을 덮어쓴다. 실제 VACUUM은 DB가 필요해 스크립트(npm run db:backup)로 검증한다.

describe('백업 대상 경로', () => {
  it('상대 경로는 prisma/ 기준으로 푼다 — Prisma가 schema.prisma 위치를 기준으로 잡기 때문', () => {
    expect(resolveSqlitePath('file:./dev.db')).toBe(
      path.resolve(process.cwd(), 'prisma', './dev.db'),
    );
  });

  it('절대 경로는 그대로 쓴다', () => {
    const abs = path.resolve('C:/tmp/x.db');
    expect(resolveSqlitePath(`file:${abs}`)).toBe(abs);
  });

  it('SQLite가 아니면 null — 이 백업 방식을 쓰면 안 된다고 알린다', () => {
    expect(resolveSqlitePath('postgresql://localhost:5432/app')).toBeNull();
    expect(resolveSqlitePath('')).toBeNull(); // DATABASE_URL 미설정
  });
});
