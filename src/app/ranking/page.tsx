import Link from "next/link";
import { hitRateLabel, showsHitRate } from "@/domain/trackRecord";
import { MIN_SAMPLE_FOR_VERIFIED } from "@/domain/constants";
import { prisma } from "@/server/db";
import { getAllTimeRanking, type RankingSort } from "@/server/leaderboardQueries";
import { EmptyState } from "../EmptyState";
import { ScoreCalculatorEntry } from "../score/ScoreCalculatorEntry";
import { StatusChip } from "../StatusChip";
import { TierChip } from "../TierChip";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

const SORTS: { key: RankingSort; label: string }[] = [
  { key: "SCORE", label: "누적 점수" },
  { key: "HIT_RATE", label: "적중률" },
  { key: "RETURN", label: "가상 수익률" },
];


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

      {/* 점수의 결과가 나열되는 화면이라 "어떻게 나온 숫자인가"를 여기서 연다 */}
      <ScoreCalculatorEntry
        title="이 점수는 어떻게 매겨지나요?"
        sub="실제 정산이 쓰는 계산식 그대로, 값을 바꿔 가며 직접 확인해 보세요"
      />

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
              {/* **표본 미달자에게는 등수를 주지 않는다** — 어뷰징이 노리는 것은
                  적중률 자체가 아니라 "랭킹 N위 · 적중률 100%"라는 한 줄이다(계정 둘로
                  반대 방향을 걸면 하나는 반드시 적중한다). 순서상 아래에 있어도 번호가
                  붙으면 그 문장이 성립하므로, 번호는 검증된 사람에게만 준다.
                  목록에서 빼지는 않는다 — 신규 리서처가 안 보이면 콜드스타트가 죽는다 */}
              <span
                className={styles.rank}
                title={
                  r.verifying
                    ? `판정 표본이 ${MIN_SAMPLE_FOR_VERIFIED}건에 못 미쳐 등수를 매기지 않습니다`
                    : undefined
                }
              >
                {r.verifying ? "—" : i + 1}
              </span>
              <div className={styles.rowMain}>
                <div className={styles.rowName}>
                  {r.name}
                  {r.careerBadge && <span className={styles.pill}>인증</span>}
                  <TierChip tier={r.tier} />
                  {r.verifying && <StatusChip status="VERIFYING" />}
                </div>
                <div className={styles.rowSub}>
                  {/* 표본이 얇으면 라벨이 이미 "검증 2/5건"이라 표본을 또 적지 않는다 */}
                  {sort === "SCORE"
                    ? showsHitRate(r.hitRate, r.sampleSize)
                      ? `적중률 ${hitRateLabel(r.hitRate, r.sampleSize)} · 표본 ${r.sampleSize}`
                      : hitRateLabel(r.hitRate, r.sampleSize)
                    : `누적 ${Math.round(r.totalScore).toLocaleString()}점 · 표본 ${r.sampleSize}`}
                </div>
              </div>
              <div className={styles.rowScore}>
                {sort === "HIT_RATE" && <div>{hitRateLabel(r.hitRate, r.sampleSize)}</div>}
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
