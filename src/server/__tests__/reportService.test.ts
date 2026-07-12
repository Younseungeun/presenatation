import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { createDraftReport, publishReport, withdrawPredictionCard } from '../reportService';

// 실제 SQLite에 마이그레이션을 적용해 게시 플로우를 종단 검증하는 통합 테스트

let prisma: PrismaClient;
let researcherId: string;

const NOW = new Date('2026-07-12T00:00:00Z');

function registryWithBtcClose(close: number): ProviderRegistry {
  const provider = new FixtureMarketDataProvider().setQuotes('KRW-BTC', [
    {
      date: '2026-07-11',
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
    },
  ]);
  return { CRYPTO: provider };
}

function draftInput() {
  return {
    researcherId,
    title: 'BTC 3개월 전망',
    summary: '요약',
    content: '본문',
    priceKrw: 10_000,
    prepaymentRatio: 0 as const,
    card: {
      assetClass: 'CRYPTO' as const,
      ticker: 'KRW-BTC',
      assetName: '비트코인',
      direction: 'UP' as const,
      targetType: 'RETURN_PCT' as const,
      targetValue: 10,
      deadline: new Date('2026-10-12T00:00:00Z'),
    },
  };
}

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'report-service-'));
  const url = `file:${path.join(dir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  prisma = new PrismaClient({ datasourceUrl: url });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('리포트 게시 플로우', () => {
  it('가입 → 초안 → 게시 → 철회 종단 흐름', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'researcher@test.io',
        penName: '테스트리서처',
        identityVerified: true,
        researcherProfile: { create: {} },
      },
      include: { researcherProfile: true },
    });
    researcherId = user.researcherProfile!.id;

    // 초안: 수수료·기준가 미확정
    const draft = await createDraftReport(prisma, draftInput());
    expect(draft.status).toBe('DRAFT');
    expect(draft.feeRateBp).toBeNull();
    expect(draft.predictionCard!.basePrice).toBeNull();

    // 게시: 직전 거래일 종가로 기준가 고정 + 브론즈 수수료 20% 확정
    const published = await publishReport(
      prisma,
      registryWithBtcClose(160_000_000),
      draft.id,
      researcherId,
      NOW,
    );
    expect(published.status).toBe('PUBLISHED');
    expect(published.feeRateBp).toBe(2000);
    expect(published.basePrice).toBe(160_000_000);

    // 이중 게시 차단
    await expect(
      publishReport(prisma, registryWithBtcClose(1), draft.id, researcherId, NOW),
    ).rejects.toThrow(/초안 상태/);

    // 철회: 기록 유지 + 판매 중지
    await withdrawPredictionCard(prisma, draft.id, researcherId, NOW);
    const after = await prisma.report.findUniqueOrThrow({
      where: { id: draft.id },
      include: { predictionCard: true },
    });
    expect(after.status).toBe('CLOSED');
    expect(after.predictionCard!.withdrawnAt).toEqual(NOW);
    expect(after.predictionCard!.basePrice).toBe(160_000_000); // 기록은 그대로

    // 이중 철회 차단
    await expect(withdrawPredictionCard(prisma, draft.id, researcherId)).rejects.toThrow(
      /게시된 리포트만/,
    );
  });

  it('브론즈가 선결제 10%로 초안을 만들면 즉시 거부', async () => {
    await expect(
      createDraftReport(prisma, { ...draftInput(), prepaymentRatio: 10 as never }),
    ).rejects.toThrow(/선결제/);
  });

  it('타인 리포트 게시 시도 거부', async () => {
    const draft = await createDraftReport(prisma, draftInput());
    await expect(
      publishReport(prisma, registryWithBtcClose(1), draft.id, 'someone-else', NOW),
    ).rejects.toThrow(/본인의 리포트/);
  });

  it('시세를 못 구하면 게시 실패 (기준가 미확정)', async () => {
    const draft = await createDraftReport(prisma, draftInput());
    const emptyRegistry: ProviderRegistry = { CRYPTO: new FixtureMarketDataProvider() };
    await expect(publishReport(prisma, emptyRegistry, draft.id, researcherId, NOW)).rejects.toThrow(
      /기준가를 확정할 수 없습니다/,
    );
  });
});
