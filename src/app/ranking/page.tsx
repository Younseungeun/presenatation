import Link from "next/link";
import { prisma } from "@/server/db";
import { getAllTimeRanking, type RankingSort } from "@/server/leaderboardQueries";
import { EmptyState } from "../EmptyState";
import { StatusChip } from "../StatusChip";
import { TierChip } from "../TierChip";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

const SORTS: { key: RankingSort; label: string }[] = [
  { key: "SCORE", label: "누적 점수" },
  { key: "HIT_RATE", label: "적중률" },
  { key: "RETURN", label: "가상 수익률" },
];

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function signed(v: number | null): string {
  return v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const sp = await searchParams;
  const sort = (SORTS.find((s) => s.key === sp.sort)?.key ?? "SCORE") as RankingSort;
  const rows = await getAllTimeRanking(prisma, sort);

  return (
    <main className={styles.page}>
      <h1 className={styles.h1}>전체 랭킹</h1>
      <p className={styles.sub}>
        전 기간·전 자산군을 통합한 누적 트랙레코드입니다. 이번 시즌·자산군별 경쟁은
        리더보드에서 볼 수 있습니다.
      </p>

      <div className={styles.tabs}>
        {SORTS.map((s) => (
          <Link
            key={s.key}
            href={`/ranking?sort=${s.key}`}
            className={`${styles.tab} ${s.key === sort ? styles.tabActive : ""}`}
          >
            {s.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          glyph="rank"
          title="아직 판정이 쌓인 리서처가 없어요"
          body="카드가 판정되기 시작하면 누적 점수·적중률·가상 수익률 순위가 이곳에 집계됩니다."
        />
      ) : (
        <div className={styles.list}>
          {rows.map((r, i) => (
            <Link key={r.researcherId} href={`/r/${r.researcherId}`} className={styles.row}>
              <span className={styles.rank}>{i + 1}</span>
              <div className={styles.rowMain}>
                <div className={styles.rowName}>
                  {r.name}
                  {r.careerBadge && <span className={styles.pill}>인증</span>}
                  <TierChip tier={r.tier} />
                  {r.verifying && <StatusChip status="VERIFYING" />}
                </div>
                <div className={styles.rowSub}>
                  {sort === "SCORE"
                    ? `적중률 ${pct(r.hitRate)} · 표본 ${r.sampleSize}`
                    : `누적 ${Math.round(r.totalScore).toLocaleString()}점 · 표본 ${r.sampleSize}`}
                </div>
              </div>
              <div className={styles.rowScore}>
                {sort === "HIT_RATE" && <div>{pct(r.hitRate)}</div>}
                {sort === "RETURN" && (
                  <div
                    className={
                      (r.hypotheticalReturnPct ?? 0) >= 0 ? styles.pos : styles.neg
                    }
                  >
                    {signed(r.hypotheticalReturnPct)}
                  </div>
                )}
                {sort === "SCORE" && (
                  <div className={r.totalScore >= 0 ? styles.pos : styles.neg}>
                    {Math.round(r.totalScore).toLocaleString()}
                  </div>
                )}
                <div className={styles.scoreLabel}>
                  {sort === "HIT_RATE" ? "적중률" : sort === "RETURN" ? "가상 수익률" : "누적 점수"}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
