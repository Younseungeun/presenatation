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
      // 실행 시점 의존을 피하기 위해 상대 시한 (3개월)
      deadline: new Date(Date.now() + 90 * 86_400_000),
    },
  };
}

/** 시간 고정이 필요한 테스트용 초안 생성 시각 (게시 시각들보다 앞) */
const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');

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
      /기준가 확정 불가/,
    );
  });

  it('코인은 게시 시점 실시간 현재가가 기준가가 된다 (직전 종가 아님)', async () => {
    const draft = await createDraftReport(prisma, draftInput());
    const provider = new FixtureMarketDataProvider()
      .setQuotes('KRW-BTC', [
        { date: '2026-07-11', open: 1, high: 1, low: 1, close: 150_000_000, volume: 1 },
      ])
      .setCurrentPrice('KRW-BTC', 158_500_000); // 게시 순간의 실시간가
    const published = await publishReport(prisma, { CRYPTO: provider }, draft.id, researcherId, NOW);
    expect(published.basePrice).toBe(158_500_000);
  });

  it('KR 당일 예측: 평일 개장 전 게시 → 기준가 소급 확정 모드', async () => {
    const input = draftInput();
    input.card = {
      assetClass: 'KR_EQUITY',
      ticker: '005930',
      assetName: '삼성전자',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 2,
      deadline: new Date('2026-07-13T06:30:00Z'), // KST 월 15:30 (당일 종가)
    };
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);

    // KST 2026-07-13(월) 07:00 — 개장 전. 시세 조회 없이 게시된다 (빈 레지스트리)
    const monPreOpen = new Date('2026-07-12T22:00:00Z');
    const published = await publishReport(prisma, {}, draft.id, researcherId, monPreOpen);
    expect(published.status).toBe('PUBLISHED');
    expect(published.basePrice).toBeNull();

    const card = await prisma.predictionCard.findUniqueOrThrow({
      where: { reportId: draft.id },
    });
    expect(card.baseMode).toBe('PREV_CLOSE_AT_JUDGMENT');
    expect(card.basePrice).toBeNull();
  });

  it('KR 당일 예측: 장 시작 후에는 당일 시한 거부(+2일부터)', async () => {
    const input = draftInput();
    input.card = {
      assetClass: 'KR_EQUITY',
      ticker: '005930',
      assetName: '삼성전자',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 2,
      deadline: new Date('2026-07-13T06:30:00Z'),
    };
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);
    const monIntraday = new Date('2026-07-13T01:00:00Z'); // KST 월 10:00 — 장중
    await expect(
      publishReport(prisma, {}, draft.id, researcherId, monIntraday),
    ).rejects.toThrow(/2일/);
  });

  it('KR 장중 게시 +2일 카드: 게시일 종가 소급 모드로 게시', async () => {
    const input = draftInput();
    input.card = {
      assetClass: 'KR_EQUITY',
      ticker: '005930',
      assetName: '삼성전자',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 2,
      deadline: new Date('2026-07-15T06:30:00Z'), // 수요일 15:30 KST
    };
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);
    const monIntraday = new Date('2026-07-13T01:00:00Z'); // KST 월 10:00 — 장중
    const published = await publishReport(prisma, {}, draft.id, researcherId, monIntraday);
    expect(published.status).toBe('PUBLISHED');

    const card = await prisma.predictionCard.findUniqueOrThrow({ where: { reportId: draft.id } });
    expect(card.baseMode).toBe('DAY_CLOSE_AT_JUDGMENT');
    expect(card.basePrice).toBeNull();
  });

  it('코인 단타(1일 시한) 초안 허용', async () => {
    const input = draftInput();
    input.card.deadline = new Date('2026-07-12T12:00:00Z'); // DRAFT_NOW + 1.5일 (코인 최소 1일)
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);
    expect(draft.status).toBe('DRAFT');
  });
});
