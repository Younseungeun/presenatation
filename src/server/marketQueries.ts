import type { PrismaClient } from '@prisma/client';
import { TIER_NAME, TIERS, type AssetClass, type Tier } from '@/domain/constants';
import {
  cardProfitabilityLevel,
  PROFITABILITY_LABEL,
  type ProfitabilityLevel,
} from '@/domain/profitability';

// 리더보드(리포트 탐색) 화면용 조회.
// 리서처 순위는 랭킹 화면(leaderboardQueries)이 담당하고, 여기서는 "지금 살 수 있는
// 예측 카드"를 주인공으로 다룬다.
//
// MarketCard는 **구매 전 공개 뷰모델**이다 — 종목(이름·티커)과 목표 수익률 원값은
// 상품 그 자체라 여기에 아예 싣지 않는다. 목록에 나가는 것은 리서처 프로필과
// 자산군·방향·수익성(자동 산출 5구간)·시한까지. 종목이 공개되는 곳은 구매 후
// 상세와 판정 완료 기록(JudgedFeedItem)뿐이다.

export interface MarketCard {
  reportId: string;
  // 제목·요약은 싣지 않는다 — 리서처 자유 입력이라 종목명이 들어가면 마스킹이 무력화된다
  priceKrw: number;
  prepaymentRatio: number;
  researcherId: string;
  researcherName: string;
  tier: string;
  careerBadge: string | null;
  /** 판정 완료 카드의 적중 비율 (판정 이력 없으면 null) */
  hitRate: number | null;
  /** 판정 완료 표본 수 — 적중률만 보이면 100%(1건)과 62%(47건)이 구별되지 않는다 */
  judgedCount: number;
  /** 이 리서처를 두 번 이상 산 구매자 비율 (구매자 없으면 null) */
  repurchaseRate: number | null;
  assetClass: string | null;
  direction: string | null;
  /** 자동 산출 수익성 5구간 (목표 수익률 원값의 마스킹 대체물) */
  profitability: ProfitabilityLevel | null;
  confidence: number | null;
  stability: number | null;
  deadline: Date | null;
  salesCount: number;
  publishedAt: Date | null;
}

type ReportWithCard = {
  id: string;
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
    direction: string;
    targetType: string;
    targetValue: number;
    basePrice: number | null;
    confidence: number;
    selfStability: number;
    deadline: Date;
  } | null;
  _count: { purchases: number };
};

const cardInclude = {
  researcher: { include: { user: { select: { penName: true, email: true } } } },
  predictionCard: true,
  _count: { select: { purchases: true } },
} as const;

/**
 * 리서처별 신뢰 지표 — 카드 목록에 함께 붙는다.
 *  · 적중률: 판정 완료(HIT/MISS) 중 적중 비율. 판정 불가는 표본에서 제외한다
 *  · 재구매율: 이 리서처의 카드를 산 사람 중 2건 이상 산 사람의 비율.
 *    "한 번 사보고 또 샀는가" — 판정이 쌓이기 전에도 읽히는 만족도 신호다.
 * 목록당 두 번의 조회로 끝난다 (카드마다 조회하면 N+1이 된다).
 */
export async function researcherSignals(
  prisma: PrismaClient,
  researcherIds: string[],
): Promise<
  Map<string, { hitRate: number | null; judgedCount: number; repurchaseRate: number | null }>
> {
  const out = new Map<
    string,
    { hitRate: number | null; judgedCount: number; repurchaseRate: number | null }
  >();
  if (researcherIds.length === 0) return out;

  const [judgments, purchases] = await Promise.all([
    prisma.judgment.findMany({
      where: { predictionCard: { report: { researcherId: { in: researcherIds } } } },
      select: { outcome: true, predictionCard: { select: { report: { select: { researcherId: true } } } } },
    }),
    prisma.purchase.findMany({
      where: { report: { researcherId: { in: researcherIds } } },
      select: { buyerId: true, report: { select: { researcherId: true } } },
    }),
  ]);

  const judged = new Map<string, { decided: number; hits: number }>();
  for (const j of judgments) {
    if (j.outcome !== 'HIT' && j.outcome !== 'MISS') continue; // 판정 불가는 표본 제외
    const id = j.predictionCard.report.researcherId;
    const acc = judged.get(id) ?? { decided: 0, hits: 0 };
    acc.decided++;
    if (j.outcome === 'HIT') acc.hits++;
    judged.set(id, acc);
  }

  // 리서처 → (구매자 → 구매 건수)
  const buyers = new Map<string, Map<string, number>>();
  for (const p of purchases) {
    const id = p.report.researcherId;
    const byBuyer = buyers.get(id) ?? new Map<string, number>();
    byBuyer.set(p.buyerId, (byBuyer.get(p.buyerId) ?? 0) + 1);
    buyers.set(id, byBuyer);
  }

  for (const id of researcherIds) {
    const j = judged.get(id);
    const b = buyers.get(id);
    const repeat = b ? [...b.values()].filter((n) => n >= 2).length : 0;
    out.set(id, {
      hitRate: j && j.decided > 0 ? j.hits / j.decided : null,
      judgedCount: j?.decided ?? 0,
      repurchaseRate: b && b.size > 0 ? repeat / b.size : null,
    });
  }
  return out;
}

/** 목록에 리서처 신뢰 지표를 한 번에 붙인다 */
async function withSignals(prisma: PrismaClient, cards: MarketCard[]): Promise<MarketCard[]> {
  const signals = await researcherSignals(prisma, [...new Set(cards.map((c) => c.researcherId))]);
  return cards.map((c) => ({ ...c, ...(signals.get(c.researcherId) ?? {}) }));
}

function toMarketCard(r: ReportWithCard): MarketCard {
  const card = r.predictionCard;
  return {
    reportId: r.id,
    priceKrw: r.priceKrw,
    prepaymentRatio: r.prepaymentRatio,
    researcherId: r.researcherId,
    researcherName: r.researcher.user.penName ?? r.researcher.user.email,
    tier: r.researcher.tier,
    careerBadge: r.researcher.careerBadge,
    // 신뢰 지표는 목록 단위로 한 번에 붙인다 (withSignals) — 카드별 조회 금지
    hitRate: null,
    judgedCount: 0,
    repurchaseRate: null,
    assetClass: card?.assetClass ?? null,
    direction: card?.direction ?? null,
    profitability: card ? cardProfitabilityLevel(card) : null,
    confidence: card?.confidence ?? null,
    stability: card?.selfStability ?? null,
    deadline: card?.deadline ?? null,
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
  return withSignals(prisma, reports.filter((r) => r._count.purchases > 0).map(toMarketCard));
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
  return withSignals(
    prisma,
    reports
      .sort((a, b) => rank(b.researcher.tier) - rank(a.researcher.tier))
      .slice(0, limit)
      .map(toMarketCard),
  );
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

/** 목표 크기 비교값 — 수익성 5구간(자산군 무관 공통 축). 원값은 구매 전 비노출이라 쓰지 않는다 */
function comparableSize(c: MarketCard): number {
  return c.profitability ?? 0;
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

/**
 * 목록 묶기 — 정렬 기준 그 자체로 구간을 나눈다.
 *
 * 같은 카드가 수십 장 이어지면 훑을 지점이 없어 벽처럼 읽힌다. 임의의 간격으로 눈금을
 * 넣는 것은 리듬처럼 보일 뿐 정보가 아니라서, 사용자가 방금 고른 정렬 기준을 구간으로
 * 쓴다. "마감 임박순"을 골랐으면 오늘 마감·이번 주·이번 달로 갈리는 것이 자연스럽고,
 * 그 제목이 곧 "지금 무엇을 보고 있는가"의 답이 된다.
 *
 * 구간이 하나뿐이면 제목을 붙이지 않는다 (전부 같은 구간이면 제목이 정보가 아니다).
 */
export interface CardGroup {
  label: string;
  cards: MarketCard[];
}

const DAY_MS = 86_400_000;

/** 정렬별 구간 정의 — [구간명, 이 카드가 그 구간인가] 순서대로 검사 */
function bucketOf(c: MarketCard, sort: MarketSort, now: Date): string {
  switch (sort) {
    case 'DEADLINE': {
      const days = c.deadline ? (c.deadline.getTime() - now.getTime()) / DAY_MS : Infinity;
      if (days <= 1) return '오늘 마감';
      if (days <= 7) return '이번 주 마감';
      if (days <= 30) return '한 달 안에 마감';
      return '그 이후';
    }
    case 'NEW': {
      const days = c.publishedAt ? (now.getTime() - c.publishedAt.getTime()) / DAY_MS : Infinity;
      if (days <= 1) return '오늘 올라온 카드';
      if (days <= 7) return '이번 주에 올라온 카드';
      return '그 이전';
    }
    case 'POPULAR':
      if (c.salesCount >= 10) return '10명 이상이 산 카드';
      if (c.salesCount >= 3) return '3명 이상이 산 카드';
      if (c.salesCount >= 1) return '구매가 있는 카드';
      return '아직 첫 구매 전';
    case 'PRICE_ASC':
    case 'PRICE_DESC':
      if (c.priceKrw < 10_000) return '1만원 미만';
      if (c.priceKrw < 30_000) return '1만~3만원';
      return '3만원 이상';
    case 'TIER':
      // 문장 속 지칭이라 TIER_NAME — 무표기 등급도 이름이 필요하다 (TIER_LABEL은 빈 문자열)
      return `${TIER_NAME[c.tier as Tier] ?? c.tier} 리서처`;
    case 'SIZE_DESC':
      return c.profitability === null
        ? '목표 미상'
        : `수익성 ${PROFITABILITY_LABEL[c.profitability]}`;
    default:
      return '';
  }
}

export function groupCards(
  cards: MarketCard[],
  sort: MarketSort,
  now = new Date(),
): CardGroup[] {
  const groups: CardGroup[] = [];
  for (const c of cards) {
    const label = bucketOf(c, sort, now);
    const last = groups[groups.length - 1];
    // 정렬된 목록이므로 같은 구간은 반드시 연달아 온다 — 마지막 그룹만 보면 된다
    if (last && last.label === label) last.cards.push(c);
    else groups.push({ label, cards: [c] });
  }
  // 구간이 하나뿐이면 제목이 정보가 아니다
  return groups.length <= 1 ? groups.map((g) => ({ ...g, label: '' })) : groups;
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
  return withSignals(prisma, sortCards(reports.map(toMarketCard), 'DEADLINE').slice(0, limit));
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

/**
 * 팔로우 섹션 — 리서처 한 명 = 블록 하나 (프로필 + 소개말 + 그 사람의 카드).
 *
 * 카드를 한 줄로 섞어 놓으면 "누가 냈는지"가 아니라 "무슨 카드가 있는지"만 남는데,
 * 팔로우의 관심사는 정확히 그 반대다. 그래서 사람을 머리로 세우고 카드를 그 아래 둔다
 * (언론사 채널 구독 화면과 같은 구성).
 *
 * 조회는 리서처 수와 무관하게 3회 — 카드 1회, 팔로워 집계 1회, 신뢰 지표 1회(withSignals).
 */
export interface FollowedSection {
  researcherId: string;
  researcherName: string;
  tier: string;
  careerBadge: string | null;
  bio: string | null;
  followers: number;
  cards: MarketCard[];
}

export async function getFollowedSections(
  prisma: PrismaClient,
  researcherIds: string[],
  /** 리서처당 노출 카드 수 */
  perResearcher = 6,
  now = new Date(),
): Promise<FollowedSection[]> {
  if (researcherIds.length === 0) return [];

  const [reports, followerCounts, profiles] = await Promise.all([
    prisma.report.findMany({
      where: { ...buyableWhere(now), researcherId: { in: researcherIds } },
      include: cardInclude,
      orderBy: { publishedAt: 'desc' },
    }),
    prisma.follow.groupBy({
      by: ['researcherId'],
      where: { researcherId: { in: researcherIds } },
      _count: { researcherId: true },
    }),
    prisma.researcherProfile.findMany({
      where: { id: { in: researcherIds } },
      select: { id: true, bio: true },
    }),
  ]);

  const followers = new Map(followerCounts.map((f) => [f.researcherId, f._count.researcherId]));
  const bios = new Map(profiles.map((p) => [p.id, p.bio]));

  const withSignal = await withSignals(prisma, reports.map(toMarketCard));

  const byResearcher = new Map<string, MarketCard[]>();
  for (const c of withSignal) {
    const list = byResearcher.get(c.researcherId) ?? [];
    if (list.length < perResearcher) list.push(c);
    byResearcher.set(c.researcherId, list);
  }

  return [...byResearcher.entries()]
    .map(([researcherId, cards]) => ({
      researcherId,
      researcherName: cards[0].researcherName,
      tier: cards[0].tier,
      careerBadge: cards[0].careerBadge,
      bio: bios.get(researcherId) ?? null,
      followers: followers.get(researcherId) ?? 0,
      cards,
    }))
    // 새 카드를 낸 사람이 위로 — 팔로우의 목적이 새 카드를 놓치지 않는 것이다
    .sort(
      (a, b) =>
        (b.cards[0].publishedAt?.getTime() ?? 0) - (a.cards[0].publishedAt?.getTime() ?? 0),
    );
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
  return withSignals(prisma, sortCards(reports.map(toMarketCard), sort));
}
