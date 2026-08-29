import type { PrismaClient } from '@prisma/client';
import { tierAtLeast, type CardQuery } from '@/domain/cardQuery';
import { ASSET_CLASSES, TIER_NAME, TIERS, type AssetClass, type Tier } from '@/domain/constants';
import {
  cardProfitabilityLevel,
  PROFITABILITY_LABEL,
  type ProfitabilityLevel,
} from '@/domain/profitability';
import { compositeStars } from '@/domain/ratingStars';
import { isSalesWindowOpen, saleStartAt, salesWindowEnd, suspendsPurchase } from '@/domain/salesWindow';
import { SNAPSHOT_STALE_MS } from '@/domain/quoteWatch';
import { cardStabilityLevel, type StabilityLevel } from '@/domain/stability';
import { cardQ } from './quoteWatchService';

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
  /** 종목 변동성 기반 안정성 5구간 — 시스템 산정, σ 미상이면 null (domain/stability.ts) */
  stability: StabilityLevel | null;
  confidence: number | null;
  deadline: Date | null;
  salesCount: number;
  publishedAt: Date | null;
  /**
   * 지금 결제가 막히는 상태인가 (남은 몫이 광고 폭의 절반 밑).
   * 스냅샷이 신선할 때만 true — 모르면 false로 두고 목록에 남긴다
   * (모르는 상태에서 상품을 지우지 않는다, domain/quoteWatch.ts).
   */
  purchaseSuspended: boolean;
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
    ticker: string;
    direction: string;
    targetType: string;
    targetValue: number;
    basePrice: number | null;
    confidence: number;
    sigmaDaily: number | null;
    deadline: Date;
    baseMode: string;
    baseConfirmedAt: Date | null;
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
    stability: cardStabilityLevel(card?.sigmaDaily),
    confidence: card?.confidence ?? null,
    deadline: card?.deadline ?? null,
    salesCount: r._count.purchases,
    publishedAt: r.publishedAt,
    // 스냅샷을 보고 채운다 (withSuspension) — 여기서는 기본값
    purchaseSuspended: false,
  };
}

/**
 * 시세 스냅샷으로 "지금 결제가 막히는 카드"를 표시한다 — **시세를 새로 부르지 않는다.**
 *
 * 목록을 그릴 때 종목마다 실시간 시세를 부르면 초당 1회 제한에서 20종목이 22초다.
 * 그래서 문턱 근처 종목만 장중에 갱신해 둔 스냅샷(InstrumentQuote)을 읽는다.
 * 스냅샷이 없거나 낡았으면 **막지 않는다** — 결제 관문이 실시간으로 최종 판단하므로
 * 목록이 틀려도 오늘보다 나빠지지 않고, 확실하지 않은 근거로 상품을 지우지 않는다.
 *
 * 계산은 **원본 행에서** 한다. MarketCard에는 종목·목표가가 없기 때문이다(마스킹) —
 * 결과인 boolean 하나만 뷰모델로 넘어가므로 목록이 종목을 흘리지 않는다.
 */
async function suspendedReportIds(
  prisma: PrismaClient,
  reports: ReportWithCard[],
  now: Date,
): Promise<Set<string>> {
  const withCard = reports.filter((r) => r.predictionCard?.basePrice != null);
  if (withCard.length === 0) return new Set();

  const rows = await prisma.instrumentQuote.findMany({
    where: { ticker: { in: [...new Set(withCard.map((r) => r.predictionCard!.ticker))] } },
    select: { assetClass: true, ticker: true, price: true, at: true },
  });
  if (rows.length === 0) return new Set();
  const quotes = new Map(rows.map((r) => [`${r.assetClass}:${r.ticker}`, r]));

  const out = new Set<string>();
  for (const r of withCard) {
    const card = r.predictionCard!;
    const snap = quotes.get(`${card.assetClass}:${card.ticker}`);
    if (!snap || now.getTime() - snap.at.getTime() >= SNAPSHOT_STALE_MS) continue;
    const q = cardQ(card, snap.price);
    if (q !== null && suspendsPurchase(q)) out.add(r.id);
  }
  return out;
}

/** "지금 살 수 있는" 목록에서 결제가 막힌 카드를 뺀다 (검색·프로필은 표시만 바꾼다) */
function dropSuspended(cards: MarketCard[]): MarketCard[] {
  return cards.filter((c) => !c.purchaseSuspended);
}

/**
 * 지금 구매 가능한 카드만 — 게시 상태 + 시한이 남아 있고 + 철회되지 않은 것.
 * 시한이 지난 카드는 곧 판정되므로 구매가 막힌다(purchaseService와 같은 기준).
 *
 * **이 함수만으로는 부족하다 — 반드시 buyableCardsLive()와 짝으로 쓴다.**
 * 판매 기간(시간 규칙)은 `게시일 + min(검증기간/3, 30일)`이라 SQL 조건으로 쓸 수 없고,
 * salesClosedAt은 하루 1회 배치가 채우는 값이라 그 사이에는 비어 있다.
 */
function buyableWhere(now: Date) {
  return {
    status: 'PUBLISHED',
    // 판매 마감(시간·구간 이탈)된 카드는 목록의 "지금 살 수 있는"에서 빠진다 —
    // 카드는 살아서 시한에 판정되지만, 이 화면들의 약속은 구매 가능성이다
    salesClosedAt: null,
    // judgment: null — 조기 판정으로 **시한 전에 결과가 나온 카드**를 거른다.
    // 예전에는 판정이 시한 이후에만 일어나 deadline 조건이 이것까지 막아 줬다.
    // NOT — 장중·장후 게시 <14일 주식(DAY_CLOSE_AT_CLOSE)은 기준가 확정 전엔 판매 시작
    // 전이라 목록에서 뺀다("오늘 장 마감 후 판매"). 확정되면 baseConfirmedAt이 채워져 들어온다
    predictionCard: {
      is: {
        deadline: { gt: now },
        withdrawnAt: null,
        judgment: null,
        NOT: { baseMode: 'DAY_CLOSE_AT_CLOSE', baseConfirmedAt: null },
      },
    },
  } as const;
}

/**
 * 조회 결과 → 실제로 살 수 있는 카드 — **buyableWhere의 나머지 절반.**
 *
 * 두 관문이 필요한 이유는 판매 마감 규칙들의 성질이 다르기 때문이다:
 *   · ADVERSE_MOVE(가격) — 일봉 종가를 봐야 알 수 있다 → 배치가 salesClosedAt에 기록 → SQL이 거른다
 *   · WINDOW_END(시간) — 게시일·시한만으로 지금 계산된다 → **여기서 거른다**
 * 시간 규칙을 배치에만 맡기면 판매 기간이 끝난 카드가 다음 배치까지 목록에 남고,
 * 목록에 남으면 구매 버튼도 살아 있다(구매 관문은 purchaseService가 따로 막지만,
 * 살 수 없는 물건을 진열하는 것 자체가 화면의 거짓말이다).
 *
 * 이름을 buyableWhere와 맞춘 것은 의도적이다 — 한쪽만 쓰면 눈에 띄게.
 */
/**
 * 판매 가능 카드 + **결제 중단 상태 표시**.
 *
 * `hide: true`인 목록("지금 살 수 있는 …")은 중단된 카드를 아예 빼고, 검색·프로필은
 * 남기되 표시만 바꾼다(사용자 확정 A안). 이름이 약속인 목록은 그 약속을 지키고,
 * 찾아 들어온 사람에게는 카드가 증발하지 않게 하는 절충이다.
 */
async function buyableCardsLive(
  prisma: PrismaClient,
  reports: ReportWithCard[],
  now: Date,
  opts: { hide: boolean },
): Promise<MarketCard[]> {
  const open = reports.filter((r) =>
    isSalesWindowOpen(
      saleStartAt(r.publishedAt, r.predictionCard?.baseMode, r.predictionCard?.baseConfirmedAt),
      r.predictionCard?.deadline,
      now,
    ),
  );
  const suspended = await suspendedReportIds(prisma, open, now);
  const cards = open.map((r) =>
    suspended.has(r.id) ? { ...toMarketCard(r), purchaseSuspended: true } : toMarketCard(r),
  );
  return opts.hide ? dropSuspended(cards) : cards;
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
  return withSignals(
    prisma,
    (await buyableCardsLive(prisma, reports, now, { hide: true })).filter((c) => c.salesCount > 0),
  );
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
  // 등급은 문자열이라 DB 정렬로는 순서가 안 나온다 — TIERS 순서로 메모리 정렬.
  // **자르기 전에 거른다** — 판매 기간이 끝난 카드를 먼저 빼지 않으면 상위 5장 중
  // 몇 자리를 살 수 없는 카드가 차지한 채 레일이 짧아진다
  const rank = (t: string) => TIERS.indexOf(t as Tier);
  return withSignals(
    prisma,
    (await buyableCardsLive(prisma, reports, now, { hide: true }))
      .sort((a, b) => rank(b.tier) - rank(a.tier))
      .slice(0, limit),
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

// "마감"은 이제 판매 마감을 뜻한다 — 검증 시한 기반인 이 정렬·구간 라벨은
// "판정"으로 부른다 (섞이면 어느 마감인지 매번 물어야 한다)
export const MARKET_SORT_LABEL: Record<MarketSort, string> = {
  DEADLINE: '판정 가까운 순',
  NEW: '최신순',
  POPULAR: '판매 많은 순',
  PRICE_ASC: '낮은 가격순',
  PRICE_DESC: '높은 가격순',
  TIER: '리서처 등급순',
  RATING_DESC: '별점 높은 순',
  SIZE_DESC: '목표 크기순',
};

/**
 * 별점 평균 (0~5) — 수익성·신뢰도를 점수 기여 가중으로 합친 값.
 * **순위표에 뜨는 확신 종합 별점과 같은 함수를 쓴다** (domain/ratingStars.ts) —
 * 정렬과 표시가 갈라지면 "별점 높은 순"인데 별이 적은 카드가 위에 오게 된다.
 * 값이 하나도 없으면 -1로 맨 뒤에 둔다 — 0으로 두면 "별 0개"인 카드와 섞인다.
 */
export function ratingAverage(c: MarketCard): number {
  return compositeStars({ profitability: c.profitability, confidence: c.confidence }) ?? -1;
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
      if (days <= 1) return '오늘 판정';
      if (days <= 7) return '이번 주 판정';
      if (days <= 30) return '한 달 안에 판정';
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

/**
 * 판매 마감이 가까운 카드 — 홈 레일용 (자산군 무관).
 *
 * 예전에는 검증 시한 임박순이었는데, 판매 마감 규칙이 생기면서 그 기준은 구조적으로
 * 깨졌다: 판매는 검증 기간의 1/3에 닫히므로 "검증 시한이 가까운 카드"는 이미 판매가
 * 끝난 카드다. 구매자의 긴박함은 "언제 판정되나"가 아니라 **"언제까지 살 수 있나"**다.
 *
 * 선별 기준은 **시간 규칙까지만** — 게시 시점에 고정된 값이라 아무것도 새지 않는다.
 * 가격 규칙(구간 이탈) 임박을 골라내면 안 된다: 매일 시세를 따라 움직이는 신호를
 * 마스킹된 카드에 다는 것이고, "곧 마감 = 거의 적중"이라는 최악의 구매를 광고하게 된다.
 *
 * **마감선이 이미 지난 카드를 반드시 먼저 걸러야 한다** (buyableCards).
 * 이 레일은 마감선 오름차순인데 하한이 없으면 *이미 지난* 카드가 가장 작은 값이라
 * 정확히 1번 자리에 온다 — 앱이 가장 눈에 띄는 곳에서 살 수 없는 카드를
 * "임박했으니 서두르라"고 광고하게 된다.
 */
export async function getSalesClosingSoonCards(
  prisma: PrismaClient,
  limit = 5,
  now = new Date(),
): Promise<MarketCard[]> {
  const reports = await prisma.report.findMany({ where: buyableWhere(now), include: cardInclude });
  const cards = (await buyableCardsLive(prisma, reports, now, { hide: true }))
    .filter((c) => c.publishedAt !== null && c.deadline !== null)
    .sort(
      (a, b) =>
        salesWindowEnd(a.publishedAt!, a.deadline!).getTime() -
        salesWindowEnd(b.publishedAt!, b.deadline!).getTime(),
    );
  return withSignals(prisma, cards.slice(0, limit));
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
// 팔로우 레일의 카드 정렬 — 리서처 순서(고정한 순)와는 다른 축이다.
// "이 사람이 뭘 냈나"를 보는 자리라 축도 사람 기준이 아니라 카드 기준이어야 한다.
export const FOLLOWED_CARD_SORTS = ['NEW', 'POPULAR', 'ASSET'] as const;
export type FollowedCardSort = (typeof FOLLOWED_CARD_SORTS)[number];

export const FOLLOWED_CARD_SORT_LABEL: Record<FollowedCardSort, string> = {
  NEW: '최신순',
  POPULAR: '인기순',
  ASSET: '자산군순',
};

/** 자산군 정렬은 ASSET_CLASSES 순서를 따른다 — 화면 탭 순서와 같아야 예측 가능하다 */
function assetRank(assetClass: string | null): number {
  const i = (ASSET_CLASSES as readonly string[]).indexOf(assetClass ?? '');
  return i < 0 ? ASSET_CLASSES.length : i;
}

function sortFollowedCards(cards: MarketCard[], sort: FollowedCardSort): MarketCard[] {
  const byNew = (a: MarketCard, b: MarketCard) =>
    (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
  return [...cards].sort((a, b) => {
    switch (sort) {
      case 'POPULAR':
        // 판매량 동률이면 최신이 앞 — 아무도 안 산 카드끼리 임의 순서가 되지 않게
        return b.salesCount - a.salesCount || byNew(a, b);
      case 'ASSET':
        return assetRank(a.assetClass) - assetRank(b.assetClass) || byNew(a, b);
      case 'NEW':
      default:
        return byNew(a, b);
    }
  });
}

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
  /** 각 리서처 레일 안에서 카드를 어떤 순서로 놓을지 */
  cardSort: FollowedCardSort = 'NEW',
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

  const withSignal = await withSignals(
    prisma,
    await buyableCardsLive(prisma, reports, now, { hide: true }),
  );

  // **자르기 전에 정렬한다** — 최신 6장을 뽑아 놓고 인기순으로 다시 세우면
  // "이 사람의 인기 카드"가 아니라 "최근 6장 중 인기 카드"가 된다
  const sorted = sortFollowedCards(withSignal, cardSort);

  const byResearcher = new Map<string, MarketCard[]>();
  for (const c of sorted) {
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
  return withSignals(
    prisma,
    sortCards(await buyableCardsLive(prisma, reports, now, { hide: true }), sort),
  );
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

  // 검색은 찾아 들어온 자리라 카드를 지우지 않는다 — 중단 표시만 붙인다
  let cards = await withSignals(prisma, await buyableCardsLive(prisma, reports, now, { hide: false }));

  // 수익성은 예측 크기에서 파생되는 값이라 DB 조건으로 걸 수 없다
  if (q.minProfitability != null) {
    const min = q.minProfitability;
    cards = cards.filter((c) => (c.profitability ?? 0) >= min);
  }
  // 안정성도 파생값(σ → 5구간) — σ 미상 카드는 조건을 통과하지 못한다
  if (q.minStability != null) {
    const min = q.minStability;
    cards = cards.filter((c) => (c.stability ?? 0) >= min);
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
