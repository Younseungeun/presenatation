import type { PrismaClient } from '@prisma/client';
import { TIERS, type AssetClass, type Tier } from '@/domain/constants';

// 리더보드(리포트 탐색) 화면용 조회.
// 리서처 순위는 랭킹 화면(leaderboardQueries)이 담당하고, 여기서는 "지금 살 수 있는
// 예측 카드"를 주인공으로 다룬다.

export interface MarketCard {
  reportId: string;
  title: string;
  summary: string;
  priceKrw: number;
  prepaymentRatio: number;
  researcherId: string;
  researcherName: string;
  tier: string;
  careerBadge: string | null;
  assetClass: string | null;
  assetName: string | null;
  ticker: string | null;
  direction: string | null;
  targetType: string | null;
  targetValue: number | null;
  deadline: Date | null;
  salesCount: number;
  publishedAt: Date | null;
}

type ReportWithCard = {
  id: string;
  title: string;
  summary: string;
  priceKrw: number;
  prepaymentRatio: number;
  researcherId: string;
  publishedAt: Date | null;
  researcher: {
    tier: string;
    careerBadge: string | null;
    user: { penName: string | null; email: string };
  };
  predictionCard: {
    assetClass: string;
    assetName: string;
    ticker: string;
    direction: string;
    targetType: string;
    targetValue: number;
    deadline: Date;
  } | null;
  _count: { purchases: number };
};

const cardInclude = {
  researcher: { include: { user: { select: { penName: true, email: true } } } },
  predictionCard: true,
  _count: { select: { purchases: true } },
} as const;

function toMarketCard(r: ReportWithCard): MarketCard {
  return {
    reportId: r.id,
    title: r.title,
    summary: r.summary,
    priceKrw: r.priceKrw,
    prepaymentRatio: r.prepaymentRatio,
    researcherId: r.researcherId,
    researcherName: r.researcher.user.penName ?? r.researcher.user.email,
    tier: r.researcher.tier,
    careerBadge: r.researcher.careerBadge,
    assetClass: r.predictionCard?.assetClass ?? null,
    assetName: r.predictionCard?.assetName ?? null,
    ticker: r.predictionCard?.ticker ?? null,
    direction: r.predictionCard?.direction ?? null,
    targetType: r.predictionCard?.targetType ?? null,
    targetValue: r.predictionCard?.targetValue ?? null,
    deadline: r.predictionCard?.deadline ?? null,
    salesCount: r._count.purchases,
    publishedAt: r.publishedAt,
  };
}

/**
 * 지금 구매 가능한 카드만 — 게시 상태 + 시한이 남아 있고 + 철회되지 않은 것.
 * 시한이 지난 카드는 곧 판정되므로 구매가 막힌다(purchaseService와 같은 기준).
 */
function buyableWhere(now: Date) {
  return {
    status: 'PUBLISHED',
    predictionCard: { is: { deadline: { gt: now }, withdrawnAt: null } },
  } as const;
}

/** 판매량 상위 — "지금 가장 잘 팔리는" */
export async function getBestSellingCards(
  prisma: PrismaClient,
  limit = 5,
  now = new Date(),
): Promise<MarketCard[]> {
  const reports = await prisma.report.findMany({
    where: buyableWhere(now),
    include: cardInclude,
    orderBy: [{ purchases: { _count: 'desc' } }, { publishedAt: 'desc' }],
    take: limit,
  });
  // 아직 아무도 안 산 카드까지 "잘 팔리는"으로 보여주지 않는다
  return reports.filter((r) => r._count.purchases > 0).map(toMarketCard);
}

/** 상위 등급 리서처가 쓴 카드 — 등급 높은 순, 같으면 최신순 */
export async function getTopTierCards(
  prisma: PrismaClient,
  limit = 5,
  now = new Date(),
): Promise<MarketCard[]> {
  const reports = await prisma.report.findMany({
    where: buyableWhere(now),
    include: cardInclude,
    orderBy: { publishedAt: 'desc' },
  });
  // 등급은 문자열이라 DB 정렬로는 순서가 안 나온다 — TIERS 순서로 메모리 정렬
  const rank = (t: string) => TIERS.indexOf(t as Tier);
  return reports
    .sort((a, b) => rank(b.researcher.tier) - rank(a.researcher.tier))
    .slice(0, limit)
    .map(toMarketCard);
}

export const MARKET_SORTS = [
  'DEADLINE',
  'NEW',
  'POPULAR',
  'PRICE_ASC',
  'PRICE_DESC',
  'TIER',
  'SIZE_DESC',
] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

export const MARKET_SORT_LABEL: Record<MarketSort, string> = {
  DEADLINE: '마감 임박순',
  NEW: '최신순',
  POPULAR: '인기순',
  PRICE_ASC: '낮은 가격순',
  PRICE_DESC: '높은 가격순',
  TIER: '리서처 등급순',
  SIZE_DESC: '목표 크기순',
};

/** 목표 크기 비교값 — 수익률형만 크기로 비교할 수 있다(목표가형은 종목마다 단위가 달라 비교 불가) */
function comparableSize(c: MarketCard): number {
  return c.targetType === 'RETURN_PCT' ? (c.targetValue ?? 0) : -1;
}

function sortCards(cards: MarketCard[], sort: MarketSort): MarketCard[] {
  const rank = (t: string) => TIERS.indexOf(t as Tier);
  const byNewest = (a: MarketCard, b: MarketCard) =>
    (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);

  const sorted = [...cards];
  switch (sort) {
    case 'NEW':
      return sorted.sort(byNewest);
    case 'POPULAR':
      return sorted.sort((a, b) => b.salesCount - a.salesCount || byNewest(a, b));
    case 'PRICE_ASC':
      return sorted.sort((a, b) => a.priceKrw - b.priceKrw || byNewest(a, b));
    case 'PRICE_DESC':
      return sorted.sort((a, b) => b.priceKrw - a.priceKrw || byNewest(a, b));
    case 'TIER':
      return sorted.sort((a, b) => rank(b.tier) - rank(a.tier) || byNewest(a, b));
    case 'SIZE_DESC':
      return sorted.sort((a, b) => comparableSize(b) - comparableSize(a) || byNewest(a, b));
    case 'DEADLINE':
    default:
      // 시한이 가까운 것부터. 시한 없는 카드는 뒤로
      return sorted.sort(
        (a, b) =>
          (a.deadline?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.deadline?.getTime() ?? Number.MAX_SAFE_INTEGER),
      );
  }
}

export interface ConsensusRow {
  assetClass: string;
  ticker: string;
  assetName: string;
  up: number;
  down: number;
  total: number;
  /** 'UP' | 'DOWN' | 'EVEN' */
  lean: 'UP' | 'DOWN' | 'EVEN';
}

/**
 * 리서처 컨센서스 — 지금 검증 중인 예측 카드의 종목별 방향 분포.
 * 시황 해설이 아니라 집계된 사실이다(플랫폼이 전망을 말하면 투자정보 제공 영역으로 넘어간다).
 * 판정 전 카드만 센다: 이미 판정된 예측은 "현재 컨센서스"가 아니다.
 */
export async function getResearcherConsensus(
  prisma: PrismaClient,
  limit = 5,
  now = new Date(),
): Promise<ConsensusRow[]> {
  const cards = await prisma.predictionCard.findMany({
    where: {
      withdrawnAt: null,
      judgment: { is: null },
      deadline: { gt: now },
      report: { status: 'PUBLISHED' },
    },
    select: { assetClass: true, ticker: true, assetName: true, direction: true },
  });

  const byTicker = new Map<string, ConsensusRow>();
  for (const c of cards) {
    const key = `${c.assetClass}:${c.ticker}`;
    const row =
      byTicker.get(key) ??
      ({
        assetClass: c.assetClass,
        ticker: c.ticker,
        assetName: c.assetName,
        up: 0,
        down: 0,
        total: 0,
        lean: 'EVEN',
      } satisfies ConsensusRow);
    if (c.direction === 'UP') row.up++;
    else row.down++;
    row.total++;
    byTicker.set(key, row);
  }

  return [...byTicker.values()]
    .map((r) => ({
      ...r,
      lean: r.up > r.down ? ('UP' as const) : r.down > r.up ? ('DOWN' as const) : ('EVEN' as const),
    }))
    .sort((a, b) => b.total - a.total || a.assetName.localeCompare(b.assetName, 'ko'))
    .slice(0, limit);
}

/** 자산군 무관 마감 임박 카드 — 홈 레일용 */
export async function getUpcomingDeadlineCards(
  prisma: PrismaClient,
  limit = 5,
  now = new Date(),
): Promise<MarketCard[]> {
  const reports = await prisma.report.findMany({ where: buyableWhere(now), include: cardInclude });
  return sortCards(reports.map(toMarketCard), 'DEADLINE').slice(0, limit);
}

export interface JudgedFeedItem {
  reportId: string;
  title: string;
  researcherId: string;
  researcherName: string;
  tier: string;
  assetClass: string;
  assetName: string;
  direction: string;
  outcome: string;
  realizedReturnPct: number | null;
  judgedAt: Date;
}

/**
 * 최근 판정된 카드 — 홈 피드.
 * 이 서비스의 핵심 증거물(예측이 실제로 자동 판정된다)이라 로그인 여부와 무관하게 공개한다.
 */
export async function getRecentJudgments(
  prisma: PrismaClient,
  limit = 6,
): Promise<JudgedFeedItem[]> {
  const judgments = await prisma.judgment.findMany({
    orderBy: { judgedAt: 'desc' },
    take: limit,
    include: {
      predictionCard: {
        include: {
          report: {
            include: {
              researcher: { include: { user: { select: { penName: true, email: true } } } },
            },
          },
        },
      },
    },
  });

  return judgments.map((j) => {
    const card = j.predictionCard;
    const report = card.report;
    return {
      reportId: report.id,
      title: report.title,
      researcherId: report.researcherId,
      researcherName: report.researcher.user.penName ?? report.researcher.user.email,
      tier: report.researcher.tier,
      assetClass: card.assetClass,
      assetName: card.assetName,
      direction: card.direction,
      outcome: j.outcome,
      realizedReturnPct: j.realizedReturnPct,
      judgedAt: j.judgedAt,
    };
  });
}

/** 자산군별 카드 목록 — 하단 탭에서 쓴다 */
export async function getCardsByAssetClass(
  prisma: PrismaClient,
  assetClass: AssetClass,
  sort: MarketSort = 'DEADLINE',
  now = new Date(),
): Promise<MarketCard[]> {
  const reports = await prisma.report.findMany({
    where: {
      ...buyableWhere(now),
      predictionCard: { is: { assetClass, deadline: { gt: now }, withdrawnAt: null } },
    },
    include: cardInclude,
  });
  // 정렬 기준 대부분이 관계 필드(시한·판매수·등급)라 한 번 읽어와 메모리에서 정렬한다
  return sortCards(reports.map(toMarketCard), sort);
}
