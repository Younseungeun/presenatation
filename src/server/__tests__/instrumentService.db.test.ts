import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  applyInstrumentListings,
  searchInstruments,
  syncInstruments,
  setInstrumentRisk,
  validateListedInstrument,
} from '../instrumentService';
import { createDraftReport } from '../reportService';
import { PublishValidationError } from '@/domain/publishReport';

// 종목 마스터: 시세 공급자 유니버스 안에서만 종목을 검색·선택·게시할 수 있는지 검증

let prisma: PrismaClient;
let researcherId: string;

beforeAll(async () => {
  prisma = createTestDb('instrument-');

  await applyInstrumentListings(prisma, 'KR_EQUITY', 'seed', [
    { ticker: '005930', name: '삼성전자', currency: 'KRW' }, // shortable (개별주식선물)
    { ticker: '000660', name: 'SK하이닉스', currency: 'KRW' }, // shortable
    { ticker: '042700', name: '한미반도체', currency: 'KRW' }, // 숏 불가
  ]);
  await applyInstrumentListings(prisma, 'CRYPTO', 'seed', [
    { ticker: 'KRW-BTC', name: '비트코인', currency: 'KRW' },
    { ticker: 'KRW-ETH', name: '이더리움', currency: 'KRW' },
  ]);

  const r = await prisma.user.create({
    data: { email: 'r@i.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('searchInstruments — 활성 종목 검색', () => {
  it('티커·종목명 부분 일치, 접두 일치 우선', async () => {
    const byName = await searchInstruments(prisma, 'KR_EQUITY', '삼성');
    expect(byName[0].ticker).toBe('005930');

    const byTicker = await searchInstruments(prisma, 'KR_EQUITY', '0006');
    expect(byTicker.map((r) => r.ticker)).toContain('000660');
  });

  it('shortableOnly: 숏 가능 종목만 (코인은 전부 숏 가능)', async () => {
    const kr = await searchInstruments(prisma, 'KR_EQUITY', '반도체', { shortableOnly: true });
    expect(kr).toEqual([]); // 한미반도체는 숏 불가

    const crypto = await searchInstruments(prisma, 'CRYPTO', '비트', { shortableOnly: true });
    expect(crypto.map((r) => r.ticker)).toEqual(['KRW-BTC']);
  });

  it('빈 질의는 빈 결과', async () => {
    expect(await searchInstruments(prisma, 'KR_EQUITY', '  ')).toEqual([]);
  });
});

describe('validateListedInstrument — 유니버스 검증', () => {
  it('유니버스 밖 종목은 거부', async () => {
    const r = await validateListedInstrument(prisma, 'KR_EQUITY', '123456', 'UP');
    expect(r.issues.join()).toMatch(/지원하지 않는 종목/);
  });

  it('하락 예측은 shortable 종목만, 종목명 정규화 반환', async () => {
    const ok = await validateListedInstrument(prisma, 'KR_EQUITY', '005930', 'DOWN');
    expect(ok.issues).toEqual([]);
    expect(ok.name).toBe('삼성전자');

    const blocked = await validateListedInstrument(prisma, 'KR_EQUITY', '042700', 'DOWN');
    expect(blocked.issues.join()).toMatch(/개별주식선물/);

    const up = await validateListedInstrument(prisma, 'KR_EQUITY', '042700', 'UP');
    expect(up.issues).toEqual([]);
  });

  it('초안 저장이 유니버스 검증을 거친다 + 종목명 정규화', async () => {
    const draft = (deadline: Date, ticker: string, assetName = 'x') => ({
      researcherId,
      title: 't',
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      prepaymentRatio: 0 as const,
      card: {
        assetClass: 'CRYPTO' as const,
        ticker,
        assetName,
        direction: 'UP' as const,
        targetType: 'RETURN_PCT' as const,
        // 이 종목들은 실제 동기화 경로로 넣어 σ가 없다 → 코인 자산군 평균(4%/일)으로
        // 물러서고, 30일 하한이 약 26%가 된다. 여기서 보는 것은 유니버스 검증이라
        // 하한을 넉넉히 넘겨 둔다
        targetValue: 30,
        confidence: 5,
        selfStability: 5,
        deadline,
      },
    });
    const deadline = new Date(Date.now() + 30 * 86_400_000);

    await expect(
      createDraftReport(prisma, draft(deadline, 'KRW-ZZZ')),
    ).rejects.toThrow(PublishValidationError);

    const ok = await createDraftReport(prisma, draft(deadline, 'KRW-BTC', '가짜이름'));
    expect(ok.predictionCard!.assetName).toBe('비트코인'); // 마스터 기준으로 정규화
  });
});

describe('syncInstruments — 공급자 목록 동기화', () => {
  it('새 목록 반영 + 목록에서 빠진 종목은 비활성(신규 게시 차단)', async () => {
    const provider = new FixtureMarketDataProvider().setInstruments([
      { ticker: 'KRW-BTC', name: '비트코인', currency: 'KRW' },
      { ticker: 'KRW-SOL', name: '솔라나', currency: 'KRW' }, // 신규
      // KRW-ETH 누락 → 거래지원 종료로 간주
    ]);
    const r = await syncInstruments(prisma, 'CRYPTO', provider);
    expect(r.upserted).toBe(2);
    expect(r.deactivated).toBe(1);

    const eth = await validateListedInstrument(prisma, 'CRYPTO', 'KRW-ETH', 'UP');
    expect(eth.issues.join()).toMatch(/지원하지 않는 종목/);
    expect(await searchInstruments(prisma, 'CRYPTO', '이더리움')).toEqual([]);

    const sol = await validateListedInstrument(prisma, 'CRYPTO', 'KRW-SOL', 'DOWN');
    expect(sol.issues).toEqual([]); // 코인 신규 종목도 숏 가능
  });

  it('빈 목록은 동기화 중단 (유니버스 전체 비활성화 사고 방지)', async () => {
    const provider = new FixtureMarketDataProvider().setInstruments([]);
    await expect(syncInstruments(prisma, 'CRYPTO', provider)).rejects.toThrow(/비어 있습니다/);
  });
});

describe('위험 종목 선별', () => {
  it('공급자 경보가 위험 등급으로 반영된다 (업비트 유의·주의)', async () => {
    await applyInstrumentListings(prisma, 'CRYPTO', 'upbit', [
      { ticker: 'KRW-BTC', name: '비트코인', currency: 'KRW' },
      {
        ticker: 'KRW-RISK',
        name: '유의코인',
        currency: 'KRW',
        risk: { warning: true, note: '업비트 유의 종목 지정' },
      },
      {
        ticker: 'KRW-CARE',
        name: '주의코인',
        currency: 'KRW',
        risk: { caution: true, note: '업비트 주의 종목 (가격 급등락)' },
      },
    ]);

    const warned = await prisma.instrument.findUniqueOrThrow({
      where: { assetClass_ticker: { assetClass: 'CRYPTO', ticker: 'KRW-RISK' } },
    });
    expect(warned.riskLevel).toBe('WARNING');
    expect(warned.riskNote).toBe('업비트 유의 종목 지정');
    expect(warned.riskSyncedAt).not.toBeNull();

    const caution = await prisma.instrument.findUniqueOrThrow({
      where: { assetClass_ticker: { assetClass: 'CRYPTO', ticker: 'KRW-CARE' } },
    });
    expect(caution.riskLevel).toBe('CAUTION');
  });

  it('경고 종목은 게시 가능하되 검색 결과에 등급이 실린다', async () => {
    const hits = await searchInstruments(prisma, 'CRYPTO', '유의코인');
    expect(hits[0]).toMatchObject({ ticker: 'KRW-RISK', riskLevel: 'WARNING' });

    const v = await validateListedInstrument(prisma, 'CRYPTO', 'KRW-RISK', 'UP');
    expect(v.issues).toEqual([]);
    expect(v.riskLevel).toBe('WARNING');
  });

  it('거래 위험(DANGER) 종목은 검색되지 않고 게시도 막힌다', async () => {
    await setInstrumentRisk(prisma, 'CRYPTO', 'KRW-RISK', 'DANGER', '거래지원 종료 예정');

    expect(await searchInstruments(prisma, 'CRYPTO', '유의코인')).toEqual([]);
    const v = await validateListedInstrument(prisma, 'CRYPTO', 'KRW-RISK', 'UP');
    expect(v.issues.join()).toMatch(/거래 위험 종목/);
    expect(v.issues.join()).toContain('거래지원 종료 예정');
  });

  it('운영자가 등록한 위험 등급을 동기화가 덮어쓰지 않는다 (공급자가 경보를 안 주는 자산군)', async () => {
    await applyInstrumentListings(prisma, 'KR_EQUITY', 'seed', [
      { ticker: '005930', name: '삼성전자', currency: 'KRW' },
      { ticker: '000660', name: 'SK하이닉스', currency: 'KRW' },
      { ticker: '042700', name: '한미반도체', currency: 'KRW' },
    ]);
    await setInstrumentRisk(prisma, 'KR_EQUITY', '042700', 'WARNING', 'KRX 투자경고');

    // 공급자 목록에 risk 필드가 없는 재동기화 — 운영자 등록값이 유지되어야 한다
    await applyInstrumentListings(prisma, 'KR_EQUITY', 'seed', [
      { ticker: '005930', name: '삼성전자', currency: 'KRW' },
      { ticker: '000660', name: 'SK하이닉스', currency: 'KRW' },
      { ticker: '042700', name: '한미반도체', currency: 'KRW' },
    ]);

    const kept = await prisma.instrument.findUniqueOrThrow({
      where: { assetClass_ticker: { assetClass: 'KR_EQUITY', ticker: '042700' } },
    });
    expect(kept.riskLevel).toBe('WARNING');
    expect(kept.riskNote).toBe('KRX 투자경고');
  });
});
