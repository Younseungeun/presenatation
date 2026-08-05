import Link from "next/link";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { prisma } from "@/server/db";
import {
  getBestSellingCards,
  getCardsByAssetClass,
  getTopTierCards,
  MARKET_SORTS,
  type MarketCard,
  type MarketSort,
} from "@/server/marketQueries";
import { CleanBanner } from "../CleanBanner";
import { EmptyState } from "../EmptyState";
import { TierChip } from "../TierChip";
import { SortPicker } from "./SortPicker";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

// 리더보드 — "지금 살 수 있는 예측 카드"를 탐색하는 화면.
// 리서처 순위(사람)는 랭킹 화면이 담당한다. 여기서는 카드가 주인공이다:
// 상단은 추천 레일(잘 팔리는 / 상위 등급), 하단은 자산군별 목록.

function dday(deadline: Date | null, now: Date): string {
  if (!deadline) return "—";
  const days = Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return "오늘 마감";
  return `D-${days}`;
}

function sizeLabel(c: MarketCard): string {
  if (c.targetValue === null) return "";
  return c.targetType === "RETURN_PCT"
    ? `${c.targetValue}%`
    : `목표가 ${c.targetValue.toLocaleString()}`;
}

function dirLabel(c: MarketCard): string {
  if (!c.direction) return "";
  return c.direction === "UP" ? "▲ 상승" : "▼ 하락";
}

/** 가로 레일용 카드 */
function RailCard({ c, now, showSales }: { c: MarketCard; now: Date; showSales?: boolean }) {
  return (
    <Link href={`/report/${c.reportId}`} className={styles.railCard}>
      <div className={styles.railTop}>
        {c.assetName && <span className={styles.railAsset}>{c.assetName}</span>}
        <span
          className={styles.railDir}
          style={{ color: c.direction === "UP" ? "var(--pos)" : "var(--neg)" }}
        >
          {dirLabel(c)} {sizeLabel(c)}
        </span>
      </div>
      <div className={styles.railCardTitle}>{c.title}</div>
      <div className={styles.railMeta}>
        <span>{c.researcherName}</span>
        <TierChip tier={c.tier} />
        {showSales && c.salesCount > 0 && <span>· {c.salesCount}명 구매</span>}
      </div>
      <div className={styles.railFoot}>
        <span className={styles.railPrice}>{c.priceKrw.toLocaleString()}원</span>
        <span className={styles.railDday}>{dday(c.deadline, now)}</span>
      </div>
    </Link>
  );
}

/** 하단 목록용 카드 */
function ListCard({ c, now }: { c: MarketCard; now: Date }) {
  return (
    <Link href={`/report/${c.reportId}`} className={styles.reportCard}>
      <div className={styles.reportTitle}>{c.title}</div>
      <div className={styles.meta}>
        <span>{c.researcherName}</span>
        <TierChip tier={c.tier} />
        {c.careerBadge && <span className={styles.pill}>인증</span>}
      </div>
      <div className={styles.meta}>
        {c.assetName && (
          <span>
            {c.assetName}({c.ticker})
          </span>
        )}
        <span style={{ color: c.direction === "UP" ? "var(--pos)" : "var(--neg)", fontWeight: 700 }}>
          {dirLabel(c)} {sizeLabel(c)}
        </span>
      </div>
      <div className={styles.meta}>
        <span style={{ fontWeight: 800 }}>{c.priceKrw.toLocaleString()}원</span>
        <span>{dday(c.deadline, now)}</span>
        {c.prepaymentRatio === 0 && <span className={styles.pill}>틀리면 100% 환불</span>}
        {c.salesCount > 0 && <span>{c.salesCount}명 구매</span>}
      </div>
    </Link>
  );
}

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

  const [bestSelling, topTier, cards] = await Promise.all([
    getBestSellingCards(prisma, 5, now),
    getTopTierCards(prisma, 5, now),
    getCardsByAssetClass(prisma, asset, sort, now),
  ]);

  return (
    <main className={styles.page}>
      <h1 className={styles.h1}>리더보드</h1>
      <p className={styles.sub}>
        지금 살 수 있는 예측 카드입니다. 모든 카드는 시한이 지나면 시장 데이터로 자동
        판정되고, 틀리면 성과 연동분이 현금으로 환불됩니다.
      </p>

      {bestSelling.length > 0 && (
        <>
          <div className={styles.railHead}>
            <span className={styles.railTitle}>지금 잘 팔리는 카드</span>
            <span className={styles.railNote}>구매 많은 순</span>
          </div>
          <div className={styles.rail}>
            {bestSelling.map((c) => (
              <RailCard key={c.reportId} c={c} now={now} showSales />
            ))}
          </div>
        </>
      )}

      {topTier.length > 0 && (
        <>
          <div className={styles.railHead}>
            <span className={styles.railTitle}>상위 등급 리서처의 카드</span>
            <span className={styles.railNote}>등급 높은 순</span>
          </div>
          <div className={styles.rail}>
            {topTier.map((c) => (
              <RailCard key={c.reportId} c={c} now={now} />
            ))}
          </div>
        </>
      )}

      {/* 클린 리서치 신고 — 카드를 사는 화면이 위반을 목격하는 자리라 여기서 강조한다 */}
      <div className={styles.cleanSlot}>
        <CleanBanner emphasis />
      </div>

      <div className={styles.railHead}>
        <span className={styles.railTitle}>자산군별 찾기</span>
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
        cards.map((c) => <ListCard key={c.reportId} c={c} now={now} />)
      )}
    </main>
  );
}
