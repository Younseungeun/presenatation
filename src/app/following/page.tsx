import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { getFollowedResearcherIds, getPinnedResearcherIds } from "@/server/followService";
import {
  FOLLOWED_CARD_SORTS,
  getFollowedSections,
  type FollowedCardSort,
} from "@/server/marketQueries";
import { getOwnedCardViews } from "@/server/ownedCardViews";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../AppHeader";
import { EmptyState } from "../EmptyState";
import { TraceNotice } from "../TraceNotice";
import { FollowedSections } from "../leaderboard/FollowedSections";
import { FollowedSortPicker } from "../leaderboard/FollowedSortPicker";
import lb from "../leaderboard/leaderboard.module.css";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

// 팔로우한 리서처 전체 — 리더보드의 "더 보기" 목적지.
//
// 리더보드에는 대표 두 명만 둔다. 팔로우가 늘수록 그 섹션이 화면을 다 먹어서
// 정작 카드 탐색이라는 리더보드의 목적이 뒤로 밀리기 때문이다.
// 여기서는 반대로 전부 보여준다 — 이 화면은 사람을 보러 온 자리다.

export default async function FollowingPage({
  searchParams,
}: {
  searchParams: Promise<{ fsort?: string }>;
}) {
  const viewerId = await getSessionUserId();
  if (!viewerId) redirect("/login?next=/following");

  const sp = await searchParams;
  const followedSort = ((FOLLOWED_CARD_SORTS as readonly string[]).includes(sp.fsort ?? "")
    ? sp.fsort
    : "NEW") as FollowedCardSort;

  const now = new Date();
  const [followedIds, pinnedIds] = await Promise.all([
    getFollowedResearcherIds(prisma, viewerId),
    getPinnedResearcherIds(prisma, viewerId),
  ]);
  const sections = await getFollowedSections(
    prisma,
    followedIds,
    6,
    now,
    pinnedIds,
    followedSort,
  );
  const ownedViews = await getOwnedCardViews(
    prisma,
    viewerId,
    sections.flatMap((s) => s.cards.map((c) => c.reportId)),
  );

  return (
    <>
      <AppHeader title="팔로우한 리서처" backHref="/leaderboard" />
      <main className={styles.page}>
        {sections.length === 0 ? (
          <EmptyState
            title={
              followedIds.length === 0
                ? "아직 팔로우한 리서처가 없어요"
                : "팔로우한 리서처가 지금 판매 중인 카드가 없어요"
            }
            body={
              followedIds.length === 0
                ? "리서처 프로필에서 팔로우하면 새 예측 카드가 올라올 때 알림을 받고 여기서 모아 볼 수 있습니다."
                : "새 카드가 올라오면 알림으로 알려드릴게요."
            }
          />
        ) : (
          <>
            <p className={styles.sub}>
              압정을 누르면 리더보드 맨 위에 고정됩니다. 고정한 순서대로 놓입니다.
            </p>
            {/* 리더보드와 같은 정렬 버튼 — 이 화면이 그 섹션의 확대판이라 조작도 같아야 한다 */}
            <div className={lb.secHead}>
              <span className={lb.secEyebrow}>
                카드
                <FollowedSortPicker
                  sort={followedSort}
                  hrefs={
                    Object.fromEntries(
                      FOLLOWED_CARD_SORTS.map((s) => [
                        s,
                        s === "NEW" ? "/following" : `/following?fsort=${s}`,
                      ]),
                    ) as Record<FollowedCardSort, string>
                  }
                />
              </span>
            </div>
            <FollowedSections sections={sections} now={now} ownedViews={ownedViews} />
            <TraceNotice />
          </>
        )}
      </main>
    </>
  );
}
