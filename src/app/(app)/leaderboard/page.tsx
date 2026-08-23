import Link from "next/link";
import { hasCriteria, parseCardQuery } from "@/domain/cardQuery";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { countCart } from "@/server/cartService";
import { prisma } from "@/server/db";
import { getFollowedResearcherIds, getPinnedResearcherIds } from "@/server/followService";
import {
  BUDGET_OPTIONS,
  getBestSellingCards,
  getCardsByAssetClass,
  FOLLOWED_CARD_SORTS,
  getFollowedSections,
  getPurchasedReportIds,
  getTopTierCards,
  groupCards,
  hasActiveFilter,
  MARKET_SORTS,
  searchCards,
  WITHIN_DAY_OPTIONS,
  type CardGroup,
  type FollowedCardSort,
  type MarketFilter,
  type MarketSort,
} from "@/server/marketQueries";
import { getMarketStats } from "@/server/marketStats";
import { getOwnedCardViews } from "@/server/ownedCardViews";
import { getUiSettings } from "@/server/appSettings";
import { getSessionUserId } from "@/server/session";
import { CleanBanner } from "../CleanBanner";
import { MarketTicker } from "../../_shared/MarketTicker";
import { OwnedCard } from "../OwnedCard";
import { WalletIcon } from "../brand/WalletIcon";
import { EmptyState } from "../EmptyState";
import { MaskedCard } from "../MaskedCard";
import { TraceNotice } from "../TraceNotice";
import { AckSalesClose } from "./AckSalesClose";
import { BestSellers } from "./BestSellers";
import { FilterBar } from "./FilterBar";
import { FollowedSections } from "./FollowedSections";
import { MoreCards } from "./MoreCards";
import { SearchBar } from "./SearchBar";
import { SearchResults } from "./SearchResults";
import { SortPicker } from "./SortPicker";
import styles from "../market.module.css";
import lb from "./leaderboard.module.css";

export const dynamic = "force-dynamic";

// 리더보드 — "지금 살 수 있는 예측 카드"를 탐색하는 화면.
// 리서처 순위(사람)는 랭킹 화면이 담당한다. 여기서는 카드가 주인공이다.
//
// 화면 구성의 원칙: **섹션마다 주인공이 다르므로 형태도 다르다.**
// 같은 카드 컴포넌트를 네 번 늘어놓으면 정보가 아니라 벽지가 된다.
//   ① 팔로우 → 주인공이 사람   → 프로필·소개말이 머리인 PR 블록
//   ② 잘 팔리는 → 주인공이 판매량 → 숫자를 앞세운 순위표
//   ③ 상위 등급 → 주인공이 카드   → 가로 레일(압축 카드)
//   ④ 자산군별 → 전체 탐색       → 세로 목록, 첫 장만 히어로로 띄워 리듬을 준다
// 훑는 속도가 섹션마다 달라지는 것이 목적이다 — 같은 속도로 계속 훑으면 지친다.

/**
 * 리더보드에 두는 팔로우 블록 수 — 한 명.
 * 팔로우가 늘수록 이 섹션이 화면을 다 먹는데, 리더보드의 목적은 카드 탐색이다.
 * 고정한 사람이 맨 앞에 오므로, 그 한 자리는 본인이 고른 사람이 차지한다.
 * (고정 버튼은 여기 두지 않는다 — 한 명만 보이는 자리에서 고정은 뜻이 없다.
 *  고르는 일은 /following에서 전부 놓고 하는 것이 맞다)
 */
const FOLLOWED_ON_LEADERBOARD = 1;

/**
 * 자산군별 목록에서 처음에 펼쳐 두는 카드 수.
 * 앞쪽은 정렬이 고른 상위라 의미가 있지만 그 뒤는 "그 외 전부"다 —
 * 다 쏟아 두면 훑는 것이 아니라 스크롤이 된다.
 */
const CARDS_BEFORE_MORE = 8;

/**
 * 구간을 유지한 채 앞 N장 / 나머지로 자른다.
 * 자른 뒤에 다시 묶지 않는 이유: groupCards는 구간이 하나뿐이면 제목을 지우므로,
 * 조각마다 다시 묶으면 같은 목록인데 앞뒤의 제목 유무가 달라진다.
 *
 * 한 구간의 중간에서 잘리면 **뒤쪽 조각은 제목을 비운다** — 펼쳤을 때 같은 구간
 * 제목이 다른 장수로 두 번 나오면 서로 다른 구간처럼 읽힌다. 제목의 장수는
 * 구간 전체 크기를 적어야 하므로 화면은 원본 groups에서 세어 표시한다.
 */
function splitGroups(groups: CardGroup[], budget: number): [CardGroup[], CardGroup[]] {
  const head: CardGroup[] = [];
  const tail: CardGroup[] = [];
  let left = budget;
  for (const g of groups) {
    if (left <= 0) {
      tail.push(g);
    } else if (g.cards.length <= left) {
      head.push(g);
      left -= g.cards.length;
    } else {
      head.push({ label: g.label, cards: g.cards.slice(0, left) });
      tail.push({ label: "", cards: g.cards.slice(left) }); // 이어지는 조각 — 제목 없음
      left = 0;
    }
  }
  return [head, tail];
}

/** 숫자 파라미터를 허용된 값 안에서만 받는다 — URL 조작으로 임의 조건이 들어오지 않게 */
function pickNumber<T extends number>(raw: string | undefined, allowed: readonly T[]): T | null {
  const n = Number(raw);
  return allowed.find((v) => v === n) ?? null;
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    asset?: string;
    sort?: string;
    refund?: string;
    budget?: string;
    within?: string;
    hideowned?: string;
    fsort?: string;
    q?: string;
  }>;
}) {
  const sp = await searchParams;
  const asset = (ASSET_CLASSES as readonly string[]).includes(sp.asset ?? "")
    ? (sp.asset as AssetClass)
    : "CRYPTO";
  const sort = ((MARKET_SORTS as readonly string[]).includes(sp.sort ?? "")
    ? sp.sort
    : "DEADLINE") as MarketSort;
  const now = new Date();

  // 필터는 정렬과 성격이 다르다 — 정렬은 순서를 바꾸고 필터는 후보를 줄인다.
  // "예산 밖의 카드"는 아래로 밀리는 게 아니라 사라져야 훑는 양이 준다
  const filter: MarketFilter = {
    refundOnly: sp.refund === "1",
    maxPriceKrw: pickNumber(sp.budget, BUDGET_OPTIONS),
    withinDays: pickNumber(sp.within, WITHIN_DAY_OPTIONS),
    hideOwned: sp.hideowned === "1",
  };

  // 팔로우 레일의 카드 정렬 — 다른 필터·정렬과 독립된 축이라 별도 파라미터
  const followedSort = ((FOLLOWED_CARD_SORTS as readonly string[]).includes(sp.fsort ?? "")
    ? sp.fsort
    : "NEW") as FollowedCardSort;
  // 팔로우 정렬만 바꾼 URL들 — 나머지 조건(자산군·정렬·필터)은 그대로 들고 간다.
  // 클라이언트 컴포넌트에 함수를 넘길 수 없어 미리 만들어 건넨다(경우의 수 셋)
  const followedSortHrefs = Object.fromEntries(
    FOLLOWED_CARD_SORTS.map((s) => {
      const q = new URLSearchParams({ asset, sort });
      if (filter.refundOnly) q.set("refund", "1");
      if (filter.maxPriceKrw) q.set("budget", String(filter.maxPriceKrw));
      if (filter.withinDays) q.set("within", String(filter.withinDays));
      if (filter.hideOwned) q.set("hideowned", "1");
      if (s !== "NEW") q.set("fsort", s);
      return [s, `/leaderboard?${q}`];
    }),
  ) as Record<FollowedCardSort, string>;

  // 검색 중에는 추천 섹션을 걷어내고 결과만 보여준다 — 찾으러 온 사람에게
  // 추천을 계속 들이미는 건 방해다
  const rawQuery = (sp.q ?? "").slice(0, 120);
  const query = parseCardQuery(rawQuery);
  const searching = hasCriteria(query);

  const viewerId = await getSessionUserId();
  const [followedIds, pinnedIds, cartCount, ownedIds] = viewerId
    ? await Promise.all([
        getFollowedResearcherIds(prisma, viewerId),
        getPinnedResearcherIds(prisma, viewerId),
        countCart(prisma, viewerId),
        getPurchasedReportIds(prisma, viewerId),
      ])
    : [[], [], 0, new Set<string>()];

  // 띠지는 운영자가 켠 경우에만 집계한다 — 꺼져 있으면 쿼리 자체를 돌리지 않는다
  const ui = await getUiSettings(prisma);
  const marketStats = ui.marketTicker
    ? await getMarketStats(prisma, { includeAmounts: ui.marketTickerAmounts }, now)
    : [];

  const [bestSellingRaw, topTierRaw, cardsRaw, followedRaw, resultsRaw] = await Promise.all([
    searching ? [] : getBestSellingCards(prisma, 5, now),
    searching ? [] : getTopTierCards(prisma, 5, now),
    searching ? [] : getCardsByAssetClass(prisma, asset, sort, now, filter),
    searching ? [] : getFollowedSections(prisma, followedIds, 6, now, pinnedIds, followedSort),
    searching ? searchCards(prisma, query, sort, now) : [],
  ]);

  // 걸러내기 전의 내 카드 수 — 숨김 칩을 그릴지 판단한다.
  // 숨긴 뒤에 세면 0이 되어 칩이 사라지고, 다시 켤 방법이 없어진다
  const ownedOnScreen = [...cardsRaw, ...bestSellingRaw, ...topTierRaw, ...resultsRaw]
    .concat(followedRaw.flatMap((s) => s.cards))
    .filter((c) => ownedIds.has(c.reportId)).length;

  // "구매한 카드 숨기기"는 **화면 전체**에 건다 — 목록에서만 지우면 레일에 그대로 남아
  // "구매한 카드가 보기 싫다"는 목적이 달성되지 않는다.
  // 카드 속성이 아니라 뷰어와의 관계로 거르는 필터라 SQL이 아니라 여기서 적용된다
  const drop = <T extends { reportId: string }>(list: T[]): T[] =>
    filter.hideOwned ? list.filter((c) => !ownedIds.has(c.reportId)) : list;

  const bestSelling = drop(bestSellingRaw);
  const topTier = drop(topTierRaw);
  const cards = drop(cardsRaw);
  const results = drop(resultsRaw);
  const followedSections = filter.hideOwned
    ? followedRaw
        .map((s) => ({ ...s, cards: drop(s.cards) }))
        .filter((s) => s.cards.length > 0)
    : followedRaw;

  // 판매 마감된 내 카드 — 남들 목록에서는 빠졌지만 구매자에게는 아직 결과를 기다리는
  // 내 물건이다. 확인(salesCloseAckAt)을 누를 때까지 이 화면에 남는다.
  // 현재 자산군 탭의 것만 — 목록의 문법(자산군별)을 그대로 따른다
  const closedOwnedIds =
    viewerId && !searching && !filter.hideOwned
      ? (
          await prisma.purchase.findMany({
            where: {
              buyerId: viewerId,
              salesCloseAckAt: null,
              report: {
                status: "PUBLISHED",
                salesClosedAt: { not: null },
                predictionCard: {
                  is: { assetClass: asset, judgment: null, withdrawnAt: null },
                },
              },
            },
            select: { reportId: true },
          })
        ).map((p) => p.reportId)
      : [];

  // 산 카드는 구성이 통째로 다르므로(OwnedCard) 공개 데이터를 따로 싣는다.
  // 화면에 실제로 있는 id로만 좁힌다 — 보유 전체를 조회하면 시세 호출이 낭비된다
  const visibleIds = [...cards, ...bestSelling, ...topTier, ...results]
    .map((c) => c.reportId)
    .concat(followedSections.flatMap((s) => s.cards.map((c) => c.reportId)))
    .filter((id) => ownedIds.has(id))
    .concat(closedOwnedIds);
  const ownedViews = await getOwnedCardViews(prisma, viewerId, [...new Set(visibleIds)]);

  // 목록은 정렬 기준 그 자체로 구간을 나눈다 — 임의 간격 눈금은 리듬처럼 보일 뿐
  // 정보가 아니고, 사용자가 방금 고른 정렬이 곧 "지금 무엇을 보는가"의 답이다
  const groups = groupCards(cards, sort, now);
  const [shownGroups, restGroups] = splitGroups(groups, CARDS_BEFORE_MORE);
  const restCount = restGroups.reduce((n, g) => n + g.cards.length, 0);
  // 구간 제목의 장수는 잘린 조각이 아니라 구간 전체 크기 — "그 이후 3장"이라 적어 놓고
  // 펼치면 20장이 더 나오는 화면은 거짓말이다
  const groupTotal = new Map(groups.map((g) => [g.label, g.cards.length]));

  /** 구간 하나 — 앞쪽과 "더 보기" 안쪽이 같은 모양이어야 펼침이 이어지는 것으로 읽힌다 */
  const renderGroup = (g: CardGroup, gi: number, hero: boolean) => (
    <section key={`${g.label}-${gi}`}>
      {g.label && (
        <div className={lb.groupHead}>
          <span className={lb.groupLabel}>{g.label}</span>
          <span className={lb.groupCount}>{groupTotal.get(g.label) ?? g.cards.length}장</span>
        </div>
      )}
      {g.cards.map((c, i) => {
        // 목록 전체의 첫 장만 히어로 — 정렬 1순위가 무엇인지가 목록의 의미를 말해준다
        const isHero = hero && gi === 0 && i === 0;
        const mine = ownedViews.get(c.reportId);
        return (
          <div key={c.reportId} className={isHero ? lb.hero : undefined}>
            {isHero && <span className={lb.heroTag}>이 정렬의 1순위</span>}
            {/* 산 카드는 질문이 "살까?"에서 "잘 되고 있나?"로 바뀌므로 다른 카드를 그린다 */}
            {mine ? (
              <OwnedCard v={mine} now={now} />
            ) : (
              <MaskedCard c={c} now={now} href={`/report/${c.reportId}`} />
            )}
          </div>
        );
      })}
    </section>
  );

  return (
    <main className={styles.page}>
      {/* 탭 화면이라 헤더가 없다. 제목은 화면에서 빼되 페이지당 h1 하나는 남긴다
          (스크린리더·문서 구조용) — 홈 화면과 같은 처리 */}
      <h1 className="srOnly">리더보드 — 지금 살 수 있는 예측 카드</h1>

      {/* 검색바 + 카드지갑 — 검색바를 살짝 좁히고 그 오른쪽에 카드지갑을 둔다 (KREAM 상단 구조).
          카드를 담아 두고 계속 탐색하는 화면이라, 담은 것으로 돌아가는 길이 탐색 화면 안에
          있어야 한다. 배지 규칙은 MY 헤더의 카드지갑과 동일.
          줄(유리 바) 자체는 SearchBar가 그린다 — 패널 열림이 줄의 z-층을 바꿔야 해서 */}
      <SearchBar
        initial={rawQuery}
        cart={
          <Link href="/cart" className={lb.cartBtn} aria-label="카드지갑">
            {/* 인투빌 카드지갑 — 0·1·2장은 그림이 구별하므로 배지는 그림이 셀 수 없는
                3장부터만 (2장 = 그림 표시 상한) */}
            <WalletIcon count={cartCount} />
            {cartCount > 2 && (
              <span className={lb.cartBadge}>{cartCount > 99 ? "99+" : cartCount}</span>
            )}
          </Link>
        }
      />

      {/* 시장 규모 띠지 — 운영자가 켰을 때만. 수치가 작을 때는 빈 마켓처럼 보여 역효과라
          기본값이 꺼짐이다 (/admin/settings) */}
      {marketStats.length > 0 && <MarketTicker stats={marketStats} />}

      {searching ? (
        <SearchResults
          query={query}
          rawQuery={rawQuery}
          results={results}
          now={now}
          ownedViews={ownedViews}
        />
      ) : (
        <>
      {/* ① 팔로우한 리서처 — 사람이 단위.
          대표 두 명만. 팔로우가 늘수록 이 섹션이 화면을 다 먹어서 카드 탐색이라는
          리더보드의 목적이 뒤로 밀린다. 나머지는 /following에서 전부 본다 */}
      {followedSections.length > 0 && (
        <>
          <div className={`${lb.secHead} ${lb.secHeadFirst}`}>
            {/* 아이브로우 = 이 섹션의 정렬 규칙. 우측 잔글씨가 아니라 제목 위에 두는 이유:
                "무슨 순서로 나열됐나"는 목록을 읽는 방법이라 제목보다 먼저 잡혀야 한다 */}
            <span className={lb.secLead}>
              {/* 아이브로우가 말하는 것은 **사람의 순서**다. 카드의 순서는 축이 달라
                  각 리서처의 선반 머리("판매 중 N장 · 최신순 ▾")가 따로 맡는다 */}
              <span className={lb.secEyebrow}>고정한 순 · 새 카드 낸 순</span>
              <span className={lb.secTitle}>팔로우한 리서처</span>
            </span>
            {followedSections.length > FOLLOWED_ON_LEADERBOARD && (
              <Link href="/following" className={lb.secMore}>
                {followedSections.length}명 모두 보기 →
              </Link>
            )}
          </div>
          <FollowedSections
            sections={followedSections.slice(0, FOLLOWED_ON_LEADERBOARD)}
            now={now}
            showPin={false}
            ownedViews={ownedViews}
            sort={followedSort}
            sortHrefs={followedSortHrefs}
          />
        </>
      )}

      {/* 팔로우는 했지만 지금 파는 카드가 없을 때 — 빈 블록 대신 한 줄로 알린다 */}
      {followedIds.length > 0 && followedSections.length === 0 && (
        <p className={styles.sub}>
          팔로우한 리서처가 지금 판매 중인 카드는 없습니다. 새 카드가 올라오면 알림으로
          알려드릴게요.
        </p>
      )}

      {/* ② 지금 잘 팔리는 — 판매량이 주인공이라 순위표로 */}
      {bestSelling.length > 0 && (
        <>
          <div className={lb.secHead}>
            <span className={lb.secLead}>
              <span className={lb.secEyebrow}>구매 많은 순</span>
              <span className={lb.secTitle}>지금 잘 팔리는 카드</span>
            </span>
          </div>
          <BestSellers cards={bestSelling} now={now} ownedIds={ownedIds} />
        </>
      )}

      {/* ③ 상위 등급 — 카드가 주인공이라 가로 레일 */}
      {topTier.length > 0 && (
        <>
          <div className={lb.secHead}>
            <span className={lb.secLead}>
              <span className={lb.secEyebrow}>등급 높은 순</span>
              <span className={lb.secTitle}>상위 등급 리서처의 카드</span>
            </span>
          </div>
          <div className={styles.rail}>
            {topTier.map((c) => {
              const mine = ownedViews.get(c.reportId);
              return mine ? (
                <OwnedCard key={c.reportId} v={mine} now={now} compact />
              ) : (
                <MaskedCard
                  key={c.reportId}
                  c={c}
                  now={now}
                  href={`/report/${c.reportId}`}
                  compact
                />
              );
            })}
          </div>
        </>
      )}

      {/* 클린 리서치 신고 — 카드를 사는 화면이 위반을 목격하는 자리라 여기서 강조한다 */}
      <div className={styles.cleanSlot}>
        <CleanBanner emphasis />
      </div>

      {/* ④ 자산군별 전체 목록 */}
      <div className={lb.secHead}>
        <span className={lb.secLead}>
          <span className={lb.secEyebrow}>지금 살 수 있는 전체 카드</span>
          <span className={lb.secTitle}>자산군별 찾기</span>
        </span>
      </div>
      <div className={styles.tabs}>
        {ASSET_CLASSES.map((a) => (
          // scroll={false} — 자산군 전환도 이 목록 안의 조작이라 보던 자리를 지킨다
          <Link
            key={a}
            href={`/leaderboard?asset=${a}&sort=${sort}`}
            scroll={false}
            className={`${styles.tab} ${a === asset ? styles.tabActive : ""}`}
          >
            {ASSET_CLASS_LABEL[a]}
          </Link>
        ))}
      </div>

      <FilterBar
        state={{ ...filter, asset, sort }}
        matched={cards.length}
        ownedCount={ownedOnScreen}
      />

      <div className={styles.sortRow}>
        <SortPicker asset={asset} sort={sort} filter={filter} />
      </div>

      {/* 판매 마감된 내 카드 — 목록 맨 위. 정렬 대상이 아니라 정리 대기 상태라
          구간에 섞지 않고 따로 세운다. 확인을 누르면 내려간다 (MY에는 계속) */}
      {closedOwnedIds.length > 0 && (
        <>
          <div className={lb.groupHead}>
            <span className={lb.groupLabel}>판매 마감된 내 카드</span>
            <span className={lb.groupCount}>{closedOwnedIds.length}장</span>
          </div>
          {closedOwnedIds.map((id) => {
            const mine = ownedViews.get(id);
            return (
              mine && (
                <AckSalesClose key={id} reportId={id}>
                  <OwnedCard v={mine} now={now} />
                </AckSalesClose>
              )
            );
          })}
        </>
      )}

      {cards.length === 0 ? (
        <EmptyState
          compact
          title={
            hasActiveFilter(filter)
              ? "이 조건에 맞는 카드가 없어요"
              : "이 자산군에는 판매 중인 카드가 없어요"
          }
          body={
            hasActiveFilter(filter)
              ? "필터를 하나 풀어 보거나 다른 자산군 탭을 확인해보세요."
              : "다른 자산군 탭을 확인해보세요."
          }
        />
      ) : (
        <>
          {shownGroups.map((g, gi) => renderGroup(g, gi, true))}
          {restCount > 0 && (
            <MoreCards count={restCount}>
              {restGroups.map((g, gi) => renderGroup(g, gi, false))}
            </MoreCards>
          )}
        </>
      )}

      {/* 배경 궤적의 정체 — 카드를 다 훑고 난 자리에 둔다.
          상단은 검색·탐색 동선이라 고지가 끼어들면 방해가 되고,
          "그 그래프 뭐였지?"라는 질문은 카드를 본 뒤에 생긴다 */}
      <TraceNotice />
        </>
      )}
    </main>
  );
}
