import Link from "next/link";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { prisma } from "@/server/db";
import { getFollowedResearcherIds } from "@/server/followService";
import {
  getBestSellingCards,
  getCardsByAssetClass,
  getFollowedSections,
  getTopTierCards,
  groupCards,
  MARKET_SORTS,
  type MarketSort,
} from "@/server/marketQueries";
import { getSessionUserId } from "@/server/session";
import { CleanBanner } from "../CleanBanner";
import { EmptyState } from "../EmptyState";
import { MaskedCard } from "../MaskedCard";
import { TraceNotice } from "../TraceNotice";
import { BestSellers } from "./BestSellers";
import { FollowedSections } from "./FollowedSections";
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

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ asset?: string; sort?: string }>;
}) {
  const sp = await searchParams;
  const asset = (ASSET_CLASSES as readonly string[]).includes(sp.asset ?? "")
    ? (sp.asset as AssetClass)
    : "CRYPTO";
  const sort = ((MARKET_SORTS as readonly string[]).includes(sp.sort ?? "")
    ? sp.sort
    : "DEADLINE") as MarketSort;
  const now = new Date();

  const viewerId = await getSessionUserId();
  const followedIds = viewerId ? await getFollowedResearcherIds(prisma, viewerId) : [];

  const [bestSelling, topTier, cards, followedSections] = await Promise.all([
    getBestSellingCards(prisma, 5, now),
    getTopTierCards(prisma, 5, now),
    getCardsByAssetClass(prisma, asset, sort, now),
    getFollowedSections(prisma, followedIds, 6, now),
  ]);

  // 목록은 정렬 기준 그 자체로 구간을 나눈다 — 임의 간격 눈금은 리듬처럼 보일 뿐
  // 정보가 아니고, 사용자가 방금 고른 정렬이 곧 "지금 무엇을 보는가"의 답이다
  const groups = groupCards(cards, sort, now);

  return (
    <main className={styles.page}>
      <h1 className={styles.h1}>리더보드</h1>
      <p className={styles.sub}>
        지금 살 수 있는 예측 카드입니다. 모든 카드는 시한이 지나면 시장 데이터로 자동
        판정되고, 틀리면 성과 연동분이 현금으로 환불됩니다.
      </p>
      {/* 카드가 나오기 전에 배경 궤적의 정체를 밝힌다 — 아래 섹션부터 이미 궤적이 보인다 */}
      <TraceNotice />

      {/* ① 팔로우한 리서처 — 사람이 단위 */}
      {followedSections.length > 0 && (
        <>
          <div className={`${lb.secHead} ${lb.secHeadFirst}`}>
            <span className={lb.secTitle}>팔로우한 리서처</span>
            <span className={lb.secNote}>새 카드 낸 순</span>
          </div>
          <FollowedSections sections={followedSections} now={now} />
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
            <span className={lb.secTitle}>지금 잘 팔리는 카드</span>
            <span className={lb.secNote}>구매 많은 순</span>
          </div>
          <BestSellers cards={bestSelling} now={now} />
        </>
      )}

      {/* ③ 상위 등급 — 카드가 주인공이라 가로 레일 */}
      {topTier.length > 0 && (
        <>
          <div className={lb.secHead}>
            <span className={lb.secTitle}>상위 등급 리서처의 카드</span>
            <span className={lb.secNote}>등급 높은 순</span>
          </div>
          <div className={styles.rail}>
            {topTier.map((c) => (
              <MaskedCard
                key={c.reportId}
                c={c}
                now={now}
                href={`/report/${c.reportId}`}
                compact
              />
            ))}
          </div>
        </>
      )}

      {/* 클린 리서치 신고 — 카드를 사는 화면이 위반을 목격하는 자리라 여기서 강조한다 */}
      <div className={styles.cleanSlot}>
        <CleanBanner emphasis />
      </div>

      {/* ④ 자산군별 전체 목록 */}
      <div className={lb.secHead}>
        <span className={lb.secTitle}>자산군별 찾기</span>
      </div>
      <div className={styles.tabs}>
        {ASSET_CLASSES.map((a) => (
          <Link
            key={a}
            href={`/leaderboard?asset=${a}&sort=${sort}`}
            className={`${styles.tab} ${a === asset ? styles.tabActive : ""}`}
          >
            {ASSET_CLASS_LABEL[a]}
          </Link>
        ))}
      </div>
      <div className={styles.sortRow}>
        <SortPicker asset={asset} sort={sort} />
      </div>

      {cards.length === 0 ? (
        <EmptyState
          compact
          title="이 자산군에는 판매 중인 카드가 없어요"
          body="다른 자산군 탭을 확인해보세요."
        />
      ) : (
        groups.map((g, gi) => (
          <section key={g.label || gi}>
            {g.label && (
              <div className={lb.groupHead}>
                <span className={lb.groupLabel}>{g.label}</span>
                <span className={lb.groupCount}>{g.cards.length}장</span>
              </div>
            )}
            {g.cards.map((c, i) => (
              // 목록 전체의 첫 장만 히어로 — 정렬 1순위가 무엇인지가 목록의 의미를 말해준다
              <div key={c.reportId} className={gi === 0 && i === 0 ? lb.hero : undefined}>
                {gi === 0 && i === 0 && <span className={lb.heroTag}>이 정렬의 1순위</span>}
                <MaskedCard c={c} now={now} href={`/report/${c.reportId}`} />
              </div>
            ))}
          </section>
        ))
      )}
    </main>
  );
}
