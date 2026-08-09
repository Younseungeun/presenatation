import type { PrismaClient } from '@prisma/client';
import { tierAtLeast, type CardQuery } from '@/domain/cardQuery';
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
    // 판매 마감(시간·구간 이탈)된 카드는 목록의 "지금 살 수 있는"에서 빠진다 —
    // 카드는 살아서 시한에 판정되지만, 이 화면들의 약속은 구매 가능성이다
    salesClosedAt: null,
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
  'RATING_DESC',
  'SIZE_DESC',
] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

export const MARKET_SORT_LABEL: Record<MarketSort, string> = {
  DEADLINE: '마감 임박순',
  NEW: '최신순',
  POPULAR: '판매 많은 순',
  PRICE_ASC: '낮은 가격순',
  PRICE_DESC: '높은 가격순',
  TIER: '리서처 등급순',
  RATING_DESC: '별점 높은 순',
  SIZE_DESC: '목표 크기순',
};

/**
 * 별점 평균 (0~5) — 카드에 뜨는 별 셋의 평균.
 * 수익성은 5구간 그대로, 신뢰도·안정성은 1~10이라 반으로 접는다(화면 표기와 같은 환산).
 * 값이 하나도 없으면 -1로 맨 뒤에 둔다 — 0으로 두면 "별 0개"인 카드와 섞인다.
 */
export function ratingAverage(c: MarketCard): number {
  const stars = [
    c.profitability,
    c.stability === null ? null : c.stability / 2,
    c.confidence === null ? null : c.confidence / 2,
  ].filter((v): v is number => v !== null);
  if (stars.length === 0) return -1;
  return stars.reduce((a, b) => a + b, 0) / stars.length;
}

/**
 * 목록 필터 — 정렬이 순서를 바꾼다면 필터는 후보를 줄인다.
 * 정렬만으로는 "예산 밖의 카드"가 아래로 밀릴 뿐 사라지지 않아 훑는 양이 그대로다.
 */
export interface MarketFilter {
  /** 선결제 0% — 틀리면 전액 환불되는 카드만. 이 서비스의 무위험 진입을 축으로 만든 것 */
  refundOnly?: boolean;
  /** 예산 상한 (원) */
  maxPriceKrw?: number | null;
  /** 남은 검증 기간 상한 (일) — "빨리 결과를 보고 싶다" */
  withinDays?: number | null;
  /**
   * 이미 산 카드를 숨긴다 — 다른 필터와 성격이 다르다.
   * 나머지는 카드의 속성으로 거르지만 이것은 **보는 사람과의 관계**로 거르므로
   * SQL이 아니라 조회 뒤에 걸린다(server/marketQueries는 뷰어를 모른다).
   */
  hideOwned?: boolean;
}

export const BUDGET_OPTIONS = [10_000, 30_000] as const;
export const WITHIN_DAY_OPTIONS = [7, 30] as const;

/** 필터가 하나라도 걸려 있나 — 화면의 "필터 해제" 표시 판단 */
export function hasActiveFilter(f: MarketFilter): boolean {
  return Boolean(f.refundOnly || f.maxPriceKrw || f.withinDays || f.hideOwned);
}

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
    case 'RATING_DESC':
      return sorted.sort((a, b) => ratingAverage(b) - ratingAverage(a) || byNewest(a, b));
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
    case 'RATING_DESC': {
      const avg = ratingAverage(c);
      if (avg < 0) return '별점 미상';
      if (avg >= 4) return '별점 4점 이상';
      if (avg >= 3) return '별점 3점대';
      return '별점 3점 미만';
    }
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
  /** 리더보드에 고정한 리서처인가 — 고정은 언제나 위에 온다 */
  pinned: boolean;
  /**
   * 이 리서처가 쓴 무료 시황 수.
   * 유료 카드는 구매 전 본문을 볼 수 없어서, 글로 판단하려면 무료 시황뿐이다 —
   * 실적이 아직 없는 리서처일수록 이 숫자가 결정적이다.
   */
  freeCount: number;
  cards: MarketCard[];
}

export async function getFollowedSections(
  prisma: PrismaClient,
  researcherIds: string[],
  /** 리서처당 노출 카드 수 */
  perResearcher = 6,
  now = new Date(),
  /** 고정한 리서처 id — 고정한 순서대로. 이들이 목록 맨 앞에 온다 */
  pinnedIds: string[] = [],
): Promise<FollowedSection[]> {
  if (researcherIds.length === 0) return [];

  const [reports, followerCounts, profiles, freeGroups] = await Promise.all([
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
    // 무료 시황 수 — 리서처 수와 무관하게 한 번에 (사람마다 세면 N+1이 된다)
    prisma.report.groupBy({
      by: ['researcherId'],
      where: {
        status: 'PUBLISHED',
        researcherId: { in: researcherIds },
        priceKrw: 0,
        predictionCard: { is: null },
      },
      _count: { researcherId: true },
    }),
  ]);

  const followers = new Map(followerCounts.map((f) => [f.researcherId, f._count.researcherId]));
  const bios = new Map(profiles.map((p) => [p.id, p.bio]));
  const freeCounts = new Map(freeGroups.map((g) => [g.researcherId, g._count.researcherId]));

  const withSignal = await withSignals(prisma, reports.map(toMarketCard));

  const byResearcher = new Map<string, MarketCard[]>();
  for (const c of withSignal) {
    const list = byResearcher.get(c.researcherId) ?? [];
    if (list.length < perResearcher) list.push(c);
    byResearcher.set(c.researcherId, list);
  }

  // 고정 순서 — 목록에 없으면 뒤로 보낸다
  const pinRank = new Map(pinnedIds.map((id, i) => [id, i]));

  return [...byResearcher.entries()]
    .map(([researcherId, cards]) => ({
      researcherId,
      researcherName: cards[0].researcherName,
      tier: cards[0].tier,
      careerBadge: cards[0].careerBadge,
      bio: bios.get(researcherId) ?? null,
      followers: followers.get(researcherId) ?? 0,
      pinned: pinRank.has(researcherId),
      freeCount: freeCounts.get(researcherId) ?? 0,
      cards,
    }))
    .sort((a, b) => {
      // 고정한 사람이 언제나 먼저, 그 안에서는 고정한 순서대로.
      // 팔로우가 늘면 최신순만으로는 "늘 보고 싶은 사람"이 아래로 밀린다
      const ra = pinRank.get(a.researcherId);
      const rb = pinRank.get(b.researcherId);
      if (ra !== undefined || rb !== undefined) {
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      }
      // 나머지는 새 카드를 낸 사람이 위로 — 팔로우의 목적이 새 카드를 놓치지 않는 것이다
      return (b.cards[0].publishedAt?.getTime() ?? 0) - (a.cards[0].publishedAt?.getTime() ?? 0);
    });
}

/** 자산군별 카드 목록 — 하단 탭에서 쓴다 */
export async function getCardsByAssetClass(
  prisma: PrismaClient,
  assetClass: AssetClass,
  sort: MarketSort = 'DEADLINE',
  now = new Date(),
  filter: MarketFilter = {},
): Promise<MarketCard[]> {
  // 필터는 DB에서 건다 — 메모리로 다 읽어와 거르면 목록이 커질수록 그대로 비용이 된다
  const deadlineCap =
    filter.withinDays != null
      ? new Date(now.getTime() + filter.withinDays * DAY_MS)
      : undefined;

  const reports = await prisma.report.findMany({
    where: {
      ...buyableWhere(now),
      ...(filter.refundOnly ? { prepaymentRatio: 0 } : {}),
      ...(filter.maxPriceKrw != null ? { priceKrw: { lte: filter.maxPriceKrw } } : {}),
      predictionCard: {
        is: {
          assetClass,
          deadline: deadlineCap ? { gt: now, lte: deadlineCap } : { gt: now },
          withdrawnAt: null,
        },
      },
    },
    include: cardInclude,
  });
  // 정렬 기준 대부분이 관계 필드(시한·판매수·등급)라 한 번 읽어와 메모리에서 정렬한다
  return withSignals(prisma, sortCards(reports.map(toMarketCard), sort));
}

/**
 * 카드 검색 — 리서처 이름 + 해시태그 조건.
 *
 * **종목으로는 검색할 수 없다.** 종목으로 좁히면 "이 조건으로 나온 카드 = 그 종목 예측"이
 * 되어 구매 전 마스킹이 통째로 뚫린다. 그래서 축은 예측의 성질(자산군·방향·확신·조건)과
 * 사람(이름·등급·인증·신규)뿐이다. 파서는 domain/cardQuery.ts.
 *
 * 걸 수 있는 조건은 DB에서 걸고, 파생값(수익성 구간·판정 이력)만 메모리에서 거른다.
 */
export async function searchCards(
  prisma: PrismaClient,
  q: CardQuery,
  sort: MarketSort = 'DEADLINE',
  now = new Date(),
): Promise<MarketCard[]> {
  const deadlineCap =
    q.withinDays != null ? new Date(now.getTime() + q.withinDays * DAY_MS) : undefined;

  // 이름·인증은 둘 다 researcher 조건이라 한 객체로 합쳐야 한다 (따로 쓰면 뒤가 앞을 덮는다)
  const researcherWhere = {
    ...(q.text ? { user: { penName: { contains: q.text } } } : {}),
    ...(q.verifiedOnly ? { careerBadge: { not: null } } : {}),
  };

  const reports = await prisma.report.findMany({
    where: {
      ...buyableWhere(now),
      ...(q.refundOnly ? { prepaymentRatio: 0 } : {}),
      ...(q.maxPriceKrw != null ? { priceKrw: { lte: q.maxPriceKrw } } : {}),
      ...(Object.keys(researcherWhere).length > 0 ? { researcher: researcherWhere } : {}),
      predictionCard: {
        is: {
          ...(q.assetClasses.length > 0 ? { assetClass: { in: q.assetClasses } } : {}),
          ...(q.direction ? { direction: q.direction } : {}),
          // 화면의 별점은 1~10을 반으로 접은 값이라, 별 N개 이상 = 원값 2N 이상
          ...(q.minStability != null
            ? { selfStability: { gte: Math.ceil(q.minStability * 2) } }
            : {}),
          ...(q.minConfidence != null
            ? { confidence: { gte: Math.ceil(q.minConfidence * 2) } }
            : {}),
          deadline: deadlineCap ? { gt: now, lte: deadlineCap } : { gt: now },
          withdrawnAt: null,
        },
      },
    },
    include: cardInclude,
  });

  let cards = await withSignals(prisma, reports.map(toMarketCard));

  // 수익성은 예측 크기에서 파생되는 값이라 DB 조건으로 걸 수 없다
  if (q.minProfitability != null) {
    const min = q.minProfitability;
    cards = cards.filter((c) => (c.profitability ?? 0) >= min);
  }
  if (q.minTier) {
    const min = q.minTier;
    cards = cards.filter((c) => tierAtLeast(c.tier, min));
  }
  // 신규 = 아직 판정된 예측이 없는 리서처. 이들은 선결제가 막혀 있어 언제나 전액 환불이다
  if (q.newcomerOnly) {
    cards = cards.filter((c) => c.judgedCount === 0);
  }

  return sortCards(cards, sort);
}

/**
 * 리서처 명함 — 무료 시황 본문 끝에 붙는 전환 지점.
 *
 * 구매 전 마스킹 때문에 유료 리포트의 본문은 살 때까지 볼 수 없다. 무료 시황은 그
 * 예외라 전문이 공개되는데, 다 읽고 나면 "이 사람이 파는 건 뭐지"로 이어질 길이 없었다.
 * 실적이 없는 신규 리서처에게는 글이 유일한 증명 수단이라 이 길이 특히 중요하다.
 */
export interface ResearcherCallout {
  researcherId: string;
  researcherName: string;
  tier: string;
  careerBadge: string | null;
  bio: string | null;
  hitRate: number | null;
  judgedCount: number;
  /** 지금 살 수 있는 카드 수 — 0이면 화면이 명함을 그리지 않는다 */
  sellingCount: number;
}

export async function getResearcherCallout(
  prisma: PrismaClient,
  researcherId: string,
  now = new Date(),
): Promise<ResearcherCallout | null> {
  const [profile, sellingCount, signals] = await Promise.all([
    prisma.researcherProfile.findUnique({
      where: { id: researcherId },
      select: {
        id: true,
        tier: true,
        careerBadge: true,
        bio: true,
        user: { select: { penName: true, email: true } },
      },
    }),
    prisma.report.count({ where: { ...buyableWhere(now), researcherId } }),
    researcherSignals(prisma, [researcherId]),
  ]);
  if (!profile) return null;

  const s = signals.get(researcherId);
  return {
    researcherId: profile.id,
    researcherName: profile.user.penName ?? profile.user.email,
    tier: profile.tier,
    careerBadge: profile.careerBadge,
    bio: profile.bio,
    hitRate: s?.hitRate ?? null,
    judgedCount: s?.judgedCount ?? 0,
    sellingCount,
  };
}

/**
 * 이 사람이 산 리포트 id 집합 — 목록에서 "이미 산 카드"를 구별하는 데 쓴다.
 *
 * 목록에서 빼지 않고 표시만 바꾸는 이유: 빼면 사람마다 목록 길이와 "N장" 집계가
 * 달라져 같은 화면을 두고 이야기할 수 없게 된다. 산 카드는 사라지는 것이 아니라
 * **다른 카드가 되는** 것이 맞다 — 파는 물건에서 내 물건으로.
 */
export async function getPurchasedReportIds(
  prisma: PrismaClient,
  buyerId: string | null,
): Promise<Set<string>> {
  if (!buyerId) return new Set();
  const rows = await prisma.purchase.findMany({
    where: { buyerId },
    select: { reportId: true },
  });
  return new Set(rows.map((r) => r.reportId));
}
