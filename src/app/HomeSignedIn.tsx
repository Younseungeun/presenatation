import Link from "next/link";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import type { BuyerPurchase } from "@/server/financeQueries";
import type { FreeReportSummary } from "@/server/freeReportService";
import type { ConsensusRow, JudgedFeedItem, MarketCard } from "@/server/marketQueries";
import { PredictionHeatmap } from "./PredictionHeatmap";
import styles from "./page.module.css";
import market from "./market.module.css";

// 로그인 홈 — "내 것"과 "방금 일어난 일"을 보여준다.
// 카드 탐색은 리더보드, 사람 순위는 랭킹이 담당하므로 여기서는 요약만 하고 넘긴다.

function dday(deadline: Date, now: Date): string {
  const days = Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return "시한 지남";
  if (days === 0) return "오늘 마감";
  return `D-${days}`;
}

function sinceLabel(d: Date, now: Date): string {
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  return new Date(d).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

function outcomeLabel(outcome: string): { text: string; color: string } {
  if (outcome === "HIT") return { text: "적중", color: "var(--pos)" };
  if (outcome === "MISS") return { text: "실패", color: "var(--neg)" };
  return { text: "판정 불가", color: "var(--warn)" };
}

export function HomeSignedIn({
  name,
  purchases,
  consensus,
  freeReports,
  feed,
  upcoming,
  now,
}: {
  name: string;
  purchases: BuyerPurchase[];
  consensus: ConsensusRow[];
  freeReports: FreeReportSummary[];
  feed: JudgedFeedItem[];
  upcoming: MarketCard[];
  now: Date;
}) {
  const active = purchases.filter((p) => !p.report.predictionCard?.judgment);
  const done = purchases.filter((p) => p.report.predictionCard?.judgment);
  const refundedKrw = purchases.reduce((a, p) => a + (p.settlement?.buyerRefundKrw ?? 0), 0);

  // 검증 중인 것 가운데 시한이 가장 가까운 카드 — 다시 들어올 이유를 만든다
  const nextUp = active
    .filter((p) => p.report.predictionCard)
    .sort(
      (a, b) =>
        a.report.predictionCard!.deadline.getTime() - b.report.predictionCard!.deadline.getTime(),
    )[0];

  return (
    <main className={styles.appHome}>
      <h1 className={styles.greeting}>{name}님</h1>
      <p className={styles.greetingSub}>
        {active.length > 0
          ? `검증 중인 예측이 ${active.length}건 있습니다.`
          : "지금 검증 중인 예측이 없습니다. 리더보드에서 카드를 찾아보세요."}
      </p>

      <Link href="/my" className={styles.statusCard}>
        <div className={styles.statusRow}>
          <div className={styles.statusItem}>
            <span className={styles.statusValue}>{active.length}</span>
            <span className={styles.statusLabel}>검증 중</span>
          </div>
          <div className={styles.statusItem}>
            <span className={styles.statusValue}>{done.length}</span>
            <span className={styles.statusLabel}>검증 완료</span>
          </div>
          <div className={styles.statusItem}>
            <span className={styles.statusValue}>{refundedKrw.toLocaleString()}</span>
            <span className={styles.statusLabel}>누적 환불(원)</span>
          </div>
        </div>
      </Link>

      {nextUp && (
        <Link href="/my?mode=buyer&tab=active" className={styles.nextUp}>
          <span className={styles.nextUpText}>
            가장 가까운 판정 · {nextUp.report.title}
          </span>
          <span className={styles.nextUpDday}>
            {dday(nextUp.report.predictionCard!.deadline, now)}
          </span>
        </Link>
      )}

      {consensus.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>예측 히트맵</span>
            <Link href="/leaderboard" className={styles.sectionMore}>
              카드 보기 →
            </Link>
          </div>
          <PredictionHeatmap consensus={consensus} />
          <p className={styles.consensusNote}>
            검증 중인 예측 카드의 종목별 방향 분포입니다. 타일 색은 상승·하락 우세, 진하기는
            쏠린 정도입니다. 플랫폼의 전망이 아니라 집계된 사실이며, 투자 판단의 근거로 삼기에
            충분한 표본이 아닐 수 있습니다.
          </p>
        </>
      )}

      {freeReports.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>무료 시황·증시 리포트</span>
            <Link href="/free" className={styles.sectionMore}>
              더 보기 →
            </Link>
          </div>
          <div>
            {freeReports.map((r) => (
              <Link key={r.reportId} href={`/report/${r.reportId}`} className={styles.freeItem}>
                <div className={styles.freeTop}>
                  <span className={styles.freeBadge}>무료</span>
                  <span className={styles.freeTitle}>{r.title}</span>
                </div>
                <div className={styles.freeSummary}>{r.summary}</div>
                <div className={styles.freeMeta}>
                  {r.researcherName} · {r.tier}
                  {r.publishedAt && ` · ${sinceLabel(r.publishedAt, now)}`}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {feed.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>방금 판정된 카드</span>
            <Link href="/ranking" className={styles.sectionMore}>
              랭킹 보기 →
            </Link>
          </div>
          <div>
            {feed.map((f) => {
              const o = outcomeLabel(f.outcome);
              return (
                <Link key={f.reportId} href={`/report/${f.reportId}`} className={styles.feedItem}>
                  <div className={styles.feedMain}>
                    <div className={styles.feedTitle}>{f.title}</div>
                    <div className={styles.feedMeta}>
                      {f.researcherName} ·{" "}
                      {ASSET_CLASS_LABEL[f.assetClass as AssetClass] ?? f.assetClass} {f.assetName}{" "}
                      · {f.direction === "UP" ? "▲ 상승" : "▼ 하락"}
                    </div>
                  </div>
                  <div className={styles.feedResult}>
                    <div className={styles.feedReturn} style={{ color: o.color }}>
                      {o.text}
                      {f.realizedReturnPct != null &&
                        ` ${f.realizedReturnPct >= 0 ? "+" : ""}${f.realizedReturnPct.toFixed(1)}%`}
                    </div>
                    <div className={styles.feedWhen}>{sinceLabel(f.judgedAt, now)}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {upcoming.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>마감 임박 카드</span>
            <Link href="/leaderboard" className={styles.sectionMore}>
              더 보기 →
            </Link>
          </div>
          <div className={market.rail}>
            {upcoming.map((c) => (
              <Link key={c.reportId} href={`/report/${c.reportId}`} className={market.railCard}>
                <div className={market.railTop}>
                  {c.assetName && <span className={market.railAsset}>{c.assetName}</span>}
                  <span
                    className={market.railDir}
                    style={{ color: c.direction === "UP" ? "var(--pos)" : "var(--neg)" }}
                  >
                    {c.direction === "UP" ? "▲ 상승" : "▼ 하락"}{" "}
                    {c.targetType === "RETURN_PCT" ? `${c.targetValue}%` : ""}
                  </span>
                </div>
                <div className={market.railCardTitle}>{c.title}</div>
                <div className={market.railMeta}>
                  <span>{c.researcherName}</span>
                  <span className={market.tier}>{c.tier}</span>
                </div>
                <div className={market.railFoot}>
                  <span className={market.railPrice}>{c.priceKrw.toLocaleString()}원</span>
                  <span className={market.railDday}>
                    {c.deadline ? dday(c.deadline, now) : "—"}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
