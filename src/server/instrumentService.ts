import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction } from '@/domain/constants';
import type { InstrumentListing, MarketDataProvider, ProviderRegistry } from '@/domain/marketData';
import {
  blocksNewCard,
  riskBlockMessage,
  toRiskLevel,
  type RiskLevel,
} from '@/domain/instrumentRisk';
import { isShortAllowed, SHORT_RESTRICTION_NOTE } from '@/domain/shortableUniverse';

// 종목 마스터(Instrument) 서비스.
// 유니버스 = 시세 공급자가 실제로 지원하는 종목 (공급자 listInstruments 동기화).
// 카드 작성은 이 안의 활성 종목만 검색·선택할 수 있고, 초안·게시 검증도 여기를 거친다
// → 게시되는 모든 카드는 판정 엔진이 시세를 조회할 수 있음이 보장된다.
// 하락(sell) 예측 가능 여부도 종목 마스터의 shortable 플래그가 단일 기준이다
// (플래그 원천: shortableUniverse.ts 초안 목록, 코인은 전부 가능).

export interface InstrumentSearchResult {
  ticker: string;
  name: string;
  currency: string;
  shortable: boolean;
  /** 거래소 지정 위험 등급 — 작성 화면에서 배지로 표시 */
  riskLevel: RiskLevel;
  riskNote: string | null;
  delistingRisk: boolean;
  marketCap: number | null;
}

/** 활성 종목 검색 — 티커·종목명 부분 일치, 접두 일치 우선 */
export async function searchInstruments(
  prisma: PrismaClient,
  assetClass: AssetClass,
  query: string,
  opts: { shortableOnly?: boolean; limit?: number } = {},
): Promise<InstrumentSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = opts.limit ?? 20;

  const rows = await prisma.instrument.findMany({
    where: {
      assetClass,
      active: true,
      ...(opts.shortableOnly ? { shortable: true } : {}),
      // 거래 위험 종목은 애초에 검색되지 않는다 (게시해도 판정 불가로 끝날 가능성이 크다)
      riskLevel: { not: 'DANGER' },
      OR: [{ ticker: { contains: q } }, { name: { contains: q } }],
    },
    select: {
      ticker: true,
      name: true,
      currency: true,
      shortable: true,
      riskLevel: true,
      riskNote: true,
      delistingRisk: true,
      marketCap: true,
    },
    take: limit * 3, // 접두 일치 재정렬 여유분
  });

  const upper = q.toUpperCase();
  const rank = (r: { ticker: string; name: string }) =>
    r.ticker.toUpperCase() === upper || r.name === q
      ? 0
      : r.ticker.toUpperCase().startsWith(upper) || r.name.startsWith(q)
        ? 1
        : 2;
  return rows
    .sort((a, b) => rank(a) - rank(b) || a.ticker.localeCompare(b.ticker))
    .slice(0, limit)
    .map((r) => ({ ...r, riskLevel: r.riskLevel as RiskLevel }));
}

/**
 * 카드의 종목이 유니버스 안에 있는지 검증 (초안 저장·게시 공용).
 * 반환된 종목명으로 assetName을 정규화한다 — 표시명 위조 방지.
 */
export async function validateListedInstrument(
  prisma: PrismaClient,
  assetClass: AssetClass,
  ticker: string,
  direction: Direction,
): Promise<{
  issues: string[];
  name?: string;
  riskLevel?: RiskLevel;
  riskNote?: string | null;
  delistingRisk?: boolean;
  marketCap?: number | null;
}> {
  const inst = await prisma.instrument.findUnique({
    where: { assetClass_ticker: { assetClass, ticker } },
  });
  if (!inst || !inst.active) {
    return {
      issues: [
        `시세 공급자가 지원하지 않는 종목입니다: ${ticker} — 종목 검색에서 선택해주세요 (지원 종목만 판정이 가능합니다)`,
      ],
    };
  }
  if (direction === 'DOWN' && !inst.shortable) {
    return {
      issues: [
        `${SHORT_RESTRICTION_NOTE[assetClass as Exclude<AssetClass, 'CRYPTO'>] ?? '하락 예측이 제한된 종목입니다'}: ${ticker}`,
      ],
      name: inst.name,
    };
  }
  const riskLevel = inst.riskLevel as RiskLevel;
  if (blocksNewCard(riskLevel)) {
    return {
      issues: [riskBlockMessage(inst.ticker, inst.name, inst.riskNote)],
      name: inst.name,
      riskLevel,
      riskNote: inst.riskNote,
    };
  }
  return {
    issues: [],
    name: inst.name,
    riskLevel,
    riskNote: inst.riskNote,
    delistingRisk: inst.delistingRisk,
    marketCap: inst.marketCap,
  };
}

/**
 * 종목 위험 등급 설정 (운영자·동기화 공용).
 * KRX 시장경보처럼 시세 공급자가 주지 않는 신호는 운영자가 여기로 등록한다.
 */
export async function setInstrumentRisk(
  prisma: PrismaClient,
  assetClass: AssetClass,
  ticker: string,
  riskLevel: RiskLevel,
  riskNote: string | null,
  extra: { delistingRisk?: boolean; marketCap?: number | null } = {},
  now = new Date(),
) {
  return prisma.instrument.update({
    where: { assetClass_ticker: { assetClass, ticker } },
    data: {
      riskLevel,
      riskNote,
      riskSyncedAt: now,
      ...(extra.delistingRisk === undefined ? {} : { delistingRisk: extra.delistingRisk }),
      ...(extra.marketCap === undefined ? {} : { marketCap: extra.marketCap }),
    },
  });
}

export interface SyncResult {
  assetClass: AssetClass;
  source: string;
  upserted: number;
  deactivated: number;
}

/**
 * 공급자 목록 → 종목 마스터 동기화 (자산군 단위 upsert).
 * 새 목록에 없는 기존 종목은 active=false (상폐·거래지원종료) — 신규 게시만 막히고
 * 진행 중 카드·판정은 영향 없다. shortable 플래그는 shortableUniverse 기준으로 갱신.
 */
export async function syncInstruments(
  prisma: PrismaClient,
  assetClass: AssetClass,
  provider: MarketDataProvider,
  now = new Date(),
): Promise<SyncResult> {
  if (!provider.listInstruments) {
    throw new Error(`${provider.sourceId} 공급자는 종목 목록 조회를 지원하지 않습니다`);
  }
  const listings = await provider.listInstruments();
  if (listings.length === 0) {
    throw new Error(`${provider.sourceId} 종목 목록이 비어 있습니다 — 동기화 중단 (기존 유니버스 유지)`);
  }
  return applyInstrumentListings(prisma, assetClass, provider.sourceId, listings, now);
}

/** 목록을 DB에 반영 (동기화·시드 공용 코어) */
export async function applyInstrumentListings(
  prisma: PrismaClient,
  assetClass: AssetClass,
  source: string,
  listings: InstrumentListing[],
  now = new Date(),
): Promise<SyncResult> {
  for (const l of listings) {
    const shortable = isShortAllowed(assetClass, l.ticker);
    // 공급자가 경보를 주는 자산군(코인)만 위험 등급을 갱신한다.
    // 주지 않는 자산군은 운영자가 등록한 값(setInstrumentRisk)을 동기화가 덮어쓰면 안 된다.
    const risk = l.risk
      ? {
          riskLevel: toRiskLevel(l.risk),
          riskNote: l.risk.note ?? null,
          riskSyncedAt: now,
        }
      : {};
    await prisma.instrument.upsert({
      where: { assetClass_ticker: { assetClass, ticker: l.ticker } },
      create: {
        assetClass,
        ticker: l.ticker,
        name: l.name,
        currency: l.currency,
        shortable,
        active: true,
        source,
        syncedAt: now,
        ...risk,
      },
      update: {
        name: l.name,
        currency: l.currency,
        shortable,
        active: true,
        source,
        syncedAt: now,
        ...risk,
      },
    });
  }
  const { count: deactivated } = await prisma.instrument.updateMany({
    where: { assetClass, active: true, ticker: { notIn: listings.map((l) => l.ticker) } },
    data: { active: false, syncedAt: now },
  });
  return { assetClass, source, upserted: listings.length, deactivated };
}

/** 레지스트리의 모든 자산군 동기화 — 목록 미지원 공급자는 건너뛴다 */
export async function syncAllInstruments(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const [assetClass, provider] of Object.entries(registry) as Array<
    [AssetClass, MarketDataProvider]
  >) {
    if (!provider.listInstruments) continue;
    results.push(await syncInstruments(prisma, assetClass, provider, now));
  }
  return results;
}
