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
  // prisma CLI가 간헐적으로 실패하는 경우가 있어 1회 재시도 (테스트 플레이크 방지)
  for (let attempt = 1; ; attempt++) {
    try {
      execSync('npx prisma migrate deploy', {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
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
    /** 하한을 시험하려는 테스트만 지정한다 (기본은 조용한 종목) */
    sigmaDaily?: number;
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
        // 예측 크기 하한이 σ로 정해지므로(scoring.minMagnitudePct) 픽스처도 σ를 명시한다.
        // 조용한 종목으로 두는 이유: 이 테스트들이 시험하는 것은 판매·결제·판정이지
        // 하한이 아니라서, 카드가 하한에 걸리지 않고 통과해야 한다.
        // 값을 비워 두면 자산군 평균으로 물러서는데, 그 상수가 바뀌면 무관한 테스트가
        // 무더기로 깨진다 — 픽스처는 자기 전제를 스스로 들고 있어야 한다.
        sigmaDaily: e.sigmaDaily ?? 0.005,
      },
      update: {
        shortable: e.shortable ?? false,
        active: e.active ?? true,
        sigmaDaily: e.sigmaDaily ?? 0.005,
      },
    });
  }
}

/**
 * 검증된 정산 계좌를 심는다 (2026-08-16).
 *
 * `assertPayoutAccountReady`가 지급·보상 양쪽 실행 관문에 붙으면서, **계좌가 없으면
 * 어떤 돈도 안 나간다.** 그 관문이 생긴 날 지급을 시험하던 파일들이 한꺼번에 깨졌는데,
 * 그게 곧 관문이 빠짐없이 걸렸다는 증거다.
 *
 * `changedAt`을 한참 과거로 두는 이유: 변경 쿨다운(ACCOUNT_CHANGE_COOLDOWN_MS)이
 * 걸리면 "계좌를 방금 바꿨다"로 막힌다. 이 헬퍼를 쓰는 시험들은 계좌가 아니라
 * 지급 절차를 보고 있으므로, 쿨다운을 미리 지나 있는 상태로 만든다.
 */
export async function seedVerifiedPayoutAccount(
  prisma: PrismaClient,
  researcherUserId: string,
): Promise<void> {
  const longAgo = new Date('2020-01-01T00:00:00Z');
  await prisma.payoutAccount.upsert({
    where: { researcherUserId },
    create: {
      researcherUserId,
      bankCode: '004',
      // 실제 암호문일 필요가 없다 — 이 헬퍼를 쓰는 시험은 복호화하지 않는다
      accountNumberEnc: 'test:test:test',
      accountLast4: '0000',
      holderName: '테스트 예금주',
      status: 'VERIFIED',
      verifiedAt: longAgo,
      changedAt: longAgo,
      createdAt: longAgo,
    },
    update: { status: 'VERIFIED', verifiedAt: longAgo, changedAt: longAgo },
  });
}
