import Link from "next/link";
import { notFound } from "next/navigation";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { cardProfitabilityLevel } from "@/domain/profitability";
import { prisma } from "@/server/db";
import { getFollowStats } from "@/server/followService";
import { getPublicProfile } from "@/server/leaderboardQueries";
import { researcherSignals } from "@/server/marketQueries";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import { FollowButton } from "./FollowButton";
import { EmptyState } from "../../EmptyState";
import { MaskedCard } from "../../MaskedCard";
import { StatusChip, outcomeStatus } from "../../StatusChip";
import { TierChip } from "../../TierChip";
import { TrackRecordChart, type TrackPoint } from "./TrackRecordChart";
import styles from "../../market.module.css";

export const dynamic = "force-dynamic";

export default async function PublicProfile({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getPublicProfile(prisma, id);
  if (!data) notFound();
  const viewerId = await getSessionUserId();
  const follow = await getFollowStats(prisma, id, viewerId);
  const now = new Date();
  // 판매 목록 카드에 붙는 리서처 신뢰 지표 (적중률·재구매율)
  const signals = (await researcherSignals(prisma, [id])).get(id) ?? {
    hitRate: null,
    judgedCount: 0,
    repurchaseRate: null,
  };

  const { profile, trackRecords, buyable, history } = data;
  const name = profile.user.penName ?? profile.user.email;

  // 자산군별 곡선·스트립 입력 — 방향 반영 실현 수익률(하락 적중 = 양수)
  const pointsByAsset = new Map<string, TrackPoint[]>();
  for (const r of history) {
    const card = r.predictionCard!;
    const j = card.judgment!;
    if (j.outcome !== "HIT" && j.outcome !== "MISS") continue;
    if (j.settledPrice == null || card.basePrice == null || card.basePrice <= 0) continue;
    const raw = ((j.settledPrice - card.basePrice) / card.basePrice) * 100;
    const list = pointsByAsset.get(card.assetClass) ?? [];
    list.push({
      judgedAt: j.judgedAt,
      adjReturnPct: card.direction === "UP" ? raw : -raw,
      outcome: j.outcome,
    });
    pointsByAsset.set(card.assetClass, list);
  }

  return (
    <>
      <AppHeader title="리서처 프로필" titleAs="span" backHref="/leaderboard" />
      <main className={styles.page}>
      <div className={styles.profileHead}>
        <h1 className={styles.h1}>{name}</h1>
        {profile.careerBadge && <span>🎖️ {profile.careerBadge}</span>}
        <TierChip tier={profile.tier} />
        {profile.advisoryRegistered && (
          <small style={{ opacity: 0.6 }}>유사투자자문업 신고</small>
        )}
      </div>

      {/* 소개말 — 리서처 본인의 목소리. 없으면 줄 자체를 그리지 않는다 */}
      {profile.bio && <p className={styles.bio}>{profile.bio}</p>}

      {/* 팔로우 — 새 예측 카드 알림을 받고 리더보드에서 모아 본다 */}
      <div className={styles.followRow}>
        <span className={styles.followCount}>
          <strong>{follow.followers.toLocaleString()}</strong> 팔로워
        </span>
        <span className={styles.followCount}>
          <strong>{follow.following.toLocaleString()}</strong> 팔로잉
        </span>
        {!follow.isSelf && (
          <FollowButton
            researcherId={id}
            initialFollowing={follow.isFollowing}
            signedIn={viewerId !== null}
          />
        )}
      </div>

      {trackRecords.length === 0 ? (
        <EmptyState
          title="아직 판정된 예측이 없어요"
          body="게시된 카드가 검증 시한에 도달하면 시장 데이터로 자동 판정되어 트랙레코드가 쌓입니다."
        />
      ) : (
        trackRecords.map((tr) => (
          <div key={tr.assetClass} style={{ marginTop: 20 }}>
            <div className={styles.section}>
              {ASSET_CLASS_LABEL[tr.assetClass as AssetClass]} 트랙레코드{" "}
              {tr.verifying && <StatusChip status="VERIFYING" label="표본 부족 · 검증 중" />}
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
            <TrackRecordChart points={pointsByAsset.get(tr.assetClass) ?? []} />
          </div>
        ))
      )}

      <div className={styles.section}>판매 중인 리포트</div>
      {buyable.length === 0 ? (
        <EmptyState compact glyph="doc" title="현재 판매 중인 리포트가 없어요" />
      ) : (
        buyable.map((r) => {
          // 구매 전 공개 범위 — 제목·요약·종목은 빼고 예측의 모양만
          const c = r.predictionCard;
          return (
            <MaskedCard
              key={r.id}
              now={now}
              href={`/report/${r.id}`}
              c={{
                researcherName: name,
                tier: profile.tier,
                careerBadge: profile.careerBadge,
                hitRate: signals.hitRate,
                judgedCount: signals.judgedCount,
                repurchaseRate: signals.repurchaseRate,
                priceKrw: r.priceKrw,
                prepaymentRatio: r.prepaymentRatio,
                deadline: c?.deadline ?? null,
                publishedAt: r.publishedAt,
                assetClass: c?.assetClass ?? null,
                direction: c?.direction ?? null,
                profitability: c ? cardProfitabilityLevel(c) : null,
                confidence: c?.confidence ?? null,
                stability: c?.selfStability ?? null,
              }}
            />
          );
        })
      )}

      {history.length > 0 && (
        <>
          <div className={styles.section}>판정 이력</div>
          {history.map((r) => (
            <Link key={r.id} href={`/report/${r.id}`} className={styles.reportCard}>
              <div className={styles.reportTitle}>
                {r.title}{" "}
                <StatusChip status={outcomeStatus(r.predictionCard!.judgment!.outcome)} />
              </div>
              <div className={styles.meta}>
                <span>
                  {ASSET_CLASS_LABEL[r.predictionCard!.assetClass as AssetClass]} {r.predictionCard!.assetName}
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
    </>
  );
}
