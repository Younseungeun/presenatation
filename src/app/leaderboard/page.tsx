import Link from "next/link";
import { ASSET_CLASSES, type AssetClass } from "@/domain/constants";
import { prisma } from "@/server/db";
import { getLeaderboard } from "@/server/leaderboardQueries";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

const ASSET_LABEL: Record<AssetClass, string> = {
  KR_EQUITY: "국내주식",
  US_EQUITY: "미국주식",
  CRYPTO: "코인",
};

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
            {ASSET_LABEL[a]}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className={styles.sub}>아직 이 자산군에 판정된 리서처가 없습니다.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.rank}>#</th>
              <th>리서처</th>
              <th className={styles.num}>시즌 점수</th>
              <th className={styles.num}>적중률</th>
              <th className={styles.num}>표본</th>
              <th className={styles.num}>가상 수익률</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.researcherId}>
                <td className={styles.rank}>{i + 1}</td>
                <td>
                  <Link className={styles.nameLink} href={`/r/${r.researcherId}`}>
                    {r.name}
                  </Link>
                  {r.careerBadge && <span className={styles.badge}>🎖️</span>}
                  <span className={styles.tier}>{r.tier}</span>
                  {r.verifying && (
                    <small style={{ marginLeft: 6, opacity: 0.6 }}>검증 중</small>
                  )}
                </td>
                <td className={`${styles.num} ${r.seasonScore >= 0 ? styles.pos : styles.neg}`}>
                  {Math.round(r.seasonScore).toLocaleString()}
                </td>
                <td className={styles.num}>{pct(r.hitRate)}</td>
                <td className={styles.num}>{r.sampleSize}</td>
                <td
                  className={`${styles.num} ${
                    (r.hypotheticalReturnPct ?? 0) >= 0 ? styles.pos : styles.neg
                  }`}
                >
                  {r.hypotheticalReturnPct === null
                    ? "—"
                    : `${r.hypotheticalReturnPct >= 0 ? "+" : ""}${r.hypotheticalReturnPct.toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
