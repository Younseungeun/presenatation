import Link from "next/link";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { prisma } from "@/server/db";
import { getLeaderboard } from "@/server/leaderboardQueries";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ asset?: string }>;
}) {
  const sp = await searchParams;
  const asset = (ASSET_CLASSES as readonly string[]).includes(sp.asset ?? "")
    ? (sp.asset as AssetClass)
    : "CRYPTO";
  const rows = await getLeaderboard(prisma, asset);

  return (
    <main className={styles.page}>
      <h1 className={styles.h1}>적중 리더보드</h1>
      <p className={styles.sub}>
        예측 카드가 시장 데이터로 자동 판정되어 쌓인 이번 시즌 점수입니다. 자산군별로
        분리 집계됩니다.
      </p>

      <div className={styles.tabs}>
        {ASSET_CLASSES.map((a) => (
          <Link
            key={a}
            href={`/leaderboard?asset=${a}`}
            className={`${styles.tab} ${a === asset ? styles.tabActive : ""}`}
          >
            {ASSET_CLASS_LABEL[a]}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className={styles.sub}>아직 이 자산군에 판정된 리서처가 없습니다.</p>
      ) : (
        <div className={styles.list}>
          {rows.map((r, i) => (
            <Link key={r.researcherId} href={`/r/${r.researcherId}`} className={styles.row}>
              <span className={styles.rank}>{i + 1}</span>
              <div className={styles.rowMain}>
                <div className={styles.rowName}>
                  {r.name}
                  {r.careerBadge && <span>🎖️</span>}
                  <span className={styles.tier}>{r.tier}</span>
                  {r.verifying && (
                    <small style={{ color: "var(--text-faint)", fontWeight: 500 }}>검증 중</small>
                  )}
                </div>
                <div className={styles.rowSub}>
                  적중률 {pct(r.hitRate)} · 표본 {r.sampleSize}
                  {r.hypotheticalReturnPct !== null &&
                    ` · 가상 ${r.hypotheticalReturnPct >= 0 ? "+" : ""}${r.hypotheticalReturnPct.toFixed(1)}%`}
                </div>
              </div>
              <div className={styles.rowScore}>
                <div className={r.seasonScore >= 0 ? styles.pos : styles.neg}>
                  {Math.round(r.seasonScore).toLocaleString()}
                </div>
                <div className={styles.scoreLabel}>시즌 점수</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
