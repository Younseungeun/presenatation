import Link from "next/link";
import { notFound } from "next/navigation";
import type { AssetClass } from "@/domain/constants";
import { prisma } from "@/server/db";
import { getPublicProfile } from "@/server/leaderboardQueries";
import styles from "../../market.module.css";

export const dynamic = "force-dynamic";

const ASSET_LABEL: Record<string, string> = {
  KR_EQUITY: "국내주식",
  US_EQUITY: "미국주식",
  CRYPTO: "코인",
};

function outcomeBadge(outcome: string) {
  if (outcome === "HIT") return <span className={styles.badgeHit}>적중</span>;
  if (outcome === "MISS") return <span className={styles.badgeMiss}>실패</span>;
  return <span className={styles.badgeUndecidable}>판정 불가</span>;
}

export default async function PublicProfile({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getPublicProfile(prisma, id);
  if (!data) notFound();

  const { profile, trackRecords, buyable, history } = data;
  const name = profile.user.penName ?? profile.user.email;

  return (
    <main className={styles.page}>
      <Link href="/leaderboard" className={styles.backLink}>
        ← 리더보드
      </Link>
      <div className={styles.profileHead} style={{ marginTop: 12 }}>
        <h1 className={styles.h1}>{name}</h1>
        {profile.careerBadge && <span>🎖️ {profile.careerBadge}</span>}
        <span className={styles.tier}>{profile.tier}</span>
        {profile.advisoryRegistered && (
          <small style={{ opacity: 0.6 }}>유사투자자문업 신고</small>
        )}
      </div>

      {trackRecords.length === 0 ? (
        <p className={styles.sub} style={{ marginTop: 16 }}>
          아직 판정된 예측이 없습니다 (검증 중).
        </p>
      ) : (
        trackRecords.map((tr) => (
          <div key={tr.assetClass} style={{ marginTop: 20 }}>
            <div className={styles.section}>
              {ASSET_LABEL[tr.assetClass as AssetClass]} 트랙레코드
              {tr.verifying && <small style={{ opacity: 0.6 }}> · 검증 중</small>}
            </div>
            <div className={styles.statGrid}>
              <div className={styles.stat}>
                <div className={styles.statLabel}>적중률</div>
                <div className={styles.statValue}>
                  {tr.hitRate === null ? "—" : `${(tr.hitRate * 100).toFixed(1)}%`}
                </div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>표본 수</div>
                <div className={styles.statValue}>{tr.sampleSize}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>최근 12개월</div>
                <div className={styles.statValue}>
                  {tr.recentHitRate === null ? "—" : `${(tr.recentHitRate * 100).toFixed(1)}%`}
                </div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>가상 수익률</div>
                <div className={styles.statValue}>
                  {tr.hypotheticalReturnPct === null
                    ? "—"
                    : `${tr.hypotheticalReturnPct >= 0 ? "+" : ""}${tr.hypotheticalReturnPct.toFixed(1)}%`}
                </div>
              </div>
            </div>
          </div>
        ))
      )}

      <div className={styles.section}>판매 중인 리포트</div>
      {buyable.length === 0 ? (
        <p className={styles.sub}>현재 판매 중인 리포트가 없습니다.</p>
      ) : (
        buyable.map((r) => (
          <Link key={r.id} href={`/report/${r.id}`} className={styles.reportCard}>
            <div className={styles.reportTitle}>{r.title}</div>
            <div className={styles.meta}>
              <span>{r.summary}</span>
            </div>
            <div className={styles.meta}>
              <span>{r.priceKrw.toLocaleString()}원</span>
              <span>선결제 {r.prepaymentRatio}%</span>
              {r.prepaymentRatio === 0 && <span>틀리면 100% 환불</span>}
            </div>
          </Link>
        ))
      )}

      {history.length > 0 && (
        <>
          <div className={styles.section}>판정 이력</div>
          {history.map((r) => (
            <Link key={r.id} href={`/report/${r.id}`} className={styles.reportCard}>
              <div className={styles.reportTitle}>
                {r.title} {outcomeBadge(r.predictionCard!.judgment!.outcome)}
              </div>
              <div className={styles.meta}>
                <span>
                  {ASSET_LABEL[r.predictionCard!.assetClass]} {r.predictionCard!.assetName}
                </span>
                {r.predictionCard!.judgment!.realizedReturnPct != null && (
                  <span>
                    실현 {r.predictionCard!.judgment!.realizedReturnPct >= 0 ? "+" : ""}
                    {r.predictionCard!.judgment!.realizedReturnPct.toFixed(1)}%
                  </span>
                )}
              </div>
            </Link>
          ))}
        </>
      )}
    </main>
  );
}
