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

/**
 * 통합 테스트가 쓰는 표준 종목을 종목 마스터에 시드한다.
 * 카드 초안·게시가 종목 마스터 검증을 거치므로, 리포트를 만드는 테스트는
 * beforeAll에서 이것부터 호출한다. 추가 종목은 entries로 넘긴다.
 */
export async function seedTestInstruments(
  prisma: PrismaClient,
  entries: Array<{
    assetClass: string;
    ticker: string;
    name?: string;
    shortable?: boolean;
    active?: boolean;
  }> = [],
) {
  const defaults: typeof entries = [
    ...['KRW-AAA', 'KRW-BBB', 'KRW-CCC', 'KRW-DDD', 'KRW-DRAFT', 'KRW-BTC'].map((ticker) => ({
      assetClass: 'CRYPTO',
      ticker,
      name: ticker.slice(4),
      shortable: true, // 코인은 선물·마진으로 전 종목 숏 가능
    })),
    { assetClass: 'KR_EQUITY', ticker: '005930', name: '삼성전자', shortable: true },
  ];
  for (const e of [...defaults, ...entries]) {
    await prisma.instrument.upsert({
      where: { assetClass_ticker: { assetClass: e.assetClass, ticker: e.ticker } },
      create: {
        assetClass: e.assetClass,
        ticker: e.ticker,
        name: e.name ?? e.ticker,
        currency: e.assetClass === 'US_EQUITY' ? 'USD' : 'KRW',
        shortable: e.shortable ?? false,
        active: e.active ?? true,
        source: 'test-seed',
      },
      update: {
        shortable: e.shortable ?? false,
        active: e.active ?? true,
      },
    });
  }
}
