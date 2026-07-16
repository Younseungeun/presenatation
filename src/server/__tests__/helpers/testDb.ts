import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * 통합 테스트 공용: 임시 SQLite에 마이그레이션을 적용한 PrismaClient.
 * 테스트 파일마다 격리된 DB를 쓴다 (vitest 파일 순차 실행 전제).
 */
export function createTestDb(prefix: string): PrismaClient {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const url = `file:${path.join(dir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  return new PrismaClient({ datasourceUrl: url });
}
