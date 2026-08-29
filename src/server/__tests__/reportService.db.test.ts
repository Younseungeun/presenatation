import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { AssetClass } from '@/domain/constants';
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
      assetClass: 'CRYPTO' as AssetClass,
      ticker: 'KRW-BTC',
      assetName: '비트코인',
      direction: 'UP' as const,
      targetType: 'RETURN_PCT' as 'RETURN_PCT' | 'TARGET_PRICE',
      targetValue: 10,
      confidence: 5 as number,
      selfStability: 5 as number,
      // 실행 시점 의존을 피하기 위해 상대 시한 (3개월)
      deadline: new Date(Date.now() + 90 * 86_400_000),
    },
  };
}

/** 시간 고정이 필요한 테스트용 초안 생성 시각 (게시 시각들보다 앞) */
const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('report-service-');
  await seedTestInstruments(prisma);
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

    // **정산이 그 자리에서 끝난다** — 시한까지 기다려도 답(전액 환불)은 안 바뀌는데
    // 그동안 구매자 돈만 에스크로에 묶인다. 365일 카드를 이틀 만에 철회하면 363일이다
    const judgment = await prisma.judgment.findFirstOrThrow({
      where: { predictionCardId: after.predictionCard!.id },
    });
    expect(judgment.outcome).toBe('UNDECIDABLE');
    expect(judgment.undecidableReason).toBe('WITHDRAWN');
    expect(judgment.score).toBe(0);
    expect(judgment.info).toBe(0); // 증거가 아니므로 규율 래더에 들어가면 안 된다

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

  // **개장 전 카드도 기준가를 게시 시점에 확정한다** (2026-08-16).
  // 직전 거래일 종가는 어제 마감 +5분에 확정된 값이고 KIS는 개장 전에도 그대로 준다
  // (실측). 미루던 이유는 금융위 D+1 지연이었고, 2026-08-10 KIS 전환으로 사라졌다.
  // ⚠ 이때는 **현재가를 묻지 않는다** — 장이 닫혀 있어 현재가 응답이 공급자 구현에
  // 달려 있고, 우리가 원하는 값은 하나로 정해져 있다(직전 거래일 종가)
  it('KR 당일 예측: 평일 개장 전 게시 → 직전 거래일 종가를 게시 시점에 확정', async () => {
    const input = draftInput();
    input.card = {
      assetClass: 'KR_EQUITY',
      ticker: '005930',
      assetName: '삼성전자',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 5,
      confidence: 5,
      selfStability: 5,
      deadline: new Date('2026-07-13T06:30:00Z'), // KST 월 15:30 (당일 종가)
    };
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);

    // KST 2026-07-13(월) 07:00 — 개장 전. 현재가가 아니라 **일봉 마지막 종가**를 쓴다
    const monPreOpen = new Date('2026-07-12T22:00:00Z');
    const provider = new FixtureMarketDataProvider()
      .setQuotes('005930', [
        { date: '2026-07-09', open: 1, high: 1, low: 1, close: 68_000, volume: 1 },
        { date: '2026-07-10', open: 1, high: 1, low: 1, close: 70_000, volume: 1 }, // 직전 거래일
      ])
      .setCurrentPrice('005930', 99_999); // 장이 닫혀 있으므로 이 값은 쓰이면 안 된다
    const published = await publishReport(
      prisma,
      { KR_EQUITY: provider },
      draft.id,
      researcherId,
      monPreOpen,
    );
    expect(published.status).toBe('PUBLISHED');
    expect(published.basePrice).toBe(70_000);

    const card = await prisma.predictionCard.findUniqueOrThrow({
      where: { reportId: draft.id },
    });
    expect(card.baseMode).toBe('PREV_CLOSE_AT_PUBLISH');
    expect(card.basePrice).toBe(70_000);
  });

  it('KR 당일 예측: 장 시작 후에는 당일 시한 거부(+2일부터)', async () => {
    const input = draftInput();
    input.card = {
      assetClass: 'KR_EQUITY',
      ticker: '005930',
      assetName: '삼성전자',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 5,
      confidence: 5,
      selfStability: 5,
      deadline: new Date('2026-07-13T06:30:00Z'),
    };
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);
    const monIntraday = new Date('2026-07-13T01:00:00Z'); // KST 월 10:00 — 장중
    await expect(
      publishReport(prisma, {}, draft.id, researcherId, monIntraday),
    ).rejects.toThrow(/2일/);
  });

  it('KR 장중 게시 +2일 카드: 목표가로 DAY_CLOSE_AT_CLOSE 게시(기준가·판매 시작 전)', async () => {
    const input = draftInput();
    input.card = {
      assetClass: 'KR_EQUITY',
      ticker: '005930',
      assetName: '삼성전자',
      direction: 'UP',
      targetType: 'TARGET_PRICE', // 장중 게시는 목표가로만 (기준가 미확정)
      targetValue: 80_000,
      confidence: 5,
      selfStability: 5,
      deadline: new Date('2026-07-15T06:30:00Z'), // 수요일 15:30 KST
    };
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);
    const monIntraday = new Date('2026-07-13T01:00:00Z'); // KST 월 10:00 — 장중
    const published = await publishReport(prisma, {}, draft.id, researcherId, monIntraday);
    expect(published.status).toBe('PUBLISHED');

    const card = await prisma.predictionCard.findUniqueOrThrow({ where: { reportId: draft.id } });
    expect(card.baseMode).toBe('DAY_CLOSE_AT_CLOSE');
    expect(card.basePrice).toBeNull();
    expect(card.baseConfirmedAt).toBeNull(); // 아직 마감 배치가 확정하기 전
  });

  it('KR 장중 게시는 수익률형(%) 거부 — 목표가로만', async () => {
    const input = draftInput();
    input.card = {
      assetClass: 'KR_EQUITY',
      ticker: '005930',
      assetName: '삼성전자',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: 5,
      confidence: 5,
      selfStability: 5,
      deadline: new Date('2026-07-15T06:30:00Z'),
    };
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);
    const monIntraday = new Date('2026-07-13T01:00:00Z'); // KST 월 10:00 — 장중
    await expect(
      publishReport(prisma, {}, draft.id, researcherId, monIntraday),
    ).rejects.toThrow(/목표가/);
  });

  it('코인 단타(1일 시한) 초안 허용', async () => {
    const input = draftInput();
    input.card.deadline = new Date('2026-07-12T12:00:00Z'); // DRAFT_NOW + 1.5일 (코인 최소 1일)
    const draft = await createDraftReport(prisma, input, DRAFT_NOW);
    expect(draft.status).toBe('DRAFT');
  });

  it('동시 활성 카드 상한: 브론즈 5건이면 6번째 게시 거부, 판정으로 슬롯 회수', async () => {
    // 별도 리서처로 격리 — 활성 카드 5건(브론즈 상한)을 직접 삽입 (게시·미판정·미철회)
    const u = await prisma.user.create({
      data: { email: 'cap@test.io', identityVerified: true, researcherProfile: { create: {} } },
      include: { researcherProfile: true },
    });
    const capResearcherId = u.researcherProfile!.id;
    const reportIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await prisma.report.create({
        data: {
          researcherId: capResearcherId,
          title: `활성 ${i}`,
          summary: 's',
          content: 'c',
          priceKrw: 10_000,
          prepaymentRatio: 0,
          feeRateBp: 2000,
          status: 'PUBLISHED',
          publishedAt: NOW,
          predictionCard: {
            create: {
              assetClass: 'CRYPTO',
              ticker: 'KRW-BTC',
              assetName: '비트코인',
              direction: 'UP',
              targetType: 'RETURN_PCT',
              targetValue: 10,
              basePrice: 100,
              deadline: new Date(Date.now() + 30 * 86_400_000),
              confidence: 1,
              selfStability: 5,
            },
          },
        },
      });
      reportIds.push(r.id);
    }

    const draft = await createDraftReport(
      prisma,
      { ...draftInput(), researcherId: capResearcherId },
      DRAFT_NOW,
    );
    const registry = {
      CRYPTO: new FixtureMarketDataProvider().setCurrentPrice('KRW-BTC', 100),
    };
    await expect(
      publishReport(prisma, registry, draft.id, capResearcherId, NOW),
    ).rejects.toThrow(/동시 활성 카드/);

    // 1건이 판정되면 슬롯이 비어 게시 가능
    const judgedCard = await prisma.predictionCard.findUniqueOrThrow({
      where: { reportId: reportIds[0] },
    });
    await prisma.judgment.create({
      data: { predictionCardId: judgedCard.id, outcome: 'HIT', score: 0, judgedAt: NOW },
    });
    const published = await publishReport(prisma, registry, draft.id, capResearcherId, NOW);
    expect(published.status).toBe('PUBLISHED');
  });
});
