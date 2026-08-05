import Link from "next/link";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { IntovillLockup } from "./brand/Logo";
import { CleanBanner } from "./CleanBanner";
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
  consensus,
  freeReports,
  feed,
  upcoming,
  now,
}: {
  name: string;
  consensus: ConsensusRow[];
  freeReports: FreeReportSummary[];
  feed: JudgedFeedItem[];
  upcoming: MarketCard[];
  now: Date;
}) {
  // 내 검증 현황(검증 중 건수·누적 환불)은 MY와 전역 판정 팝업이 담당한다 —
  // 홈 본문은 히트맵·리포트·카드 탐색만 다룬다
  return (
    <main className={styles.appHome}>
      {/* 좌측 상단 브랜드 — 축소판 +25% (height 22.5, 락업 최소폭 155px 규정 예외).
          태그라인은 락업 폭에 쏙 들어가는 크기 */}
      <div className={styles.brandRow}>
        {/* 심볼은 원위치, 워드마크(INTOVILL)만 살짝 위로 — 아래 태그라인과 한 덩어리 */}
        <IntovillLockup height={22.5} wordmarkOffsetY={-5} />
        <p className={styles.brandTagline}>맞히는 리서처만 살아남는 리포트 마켓</p>
      </div>

      {/* 인사말은 화면에서 뺐지만 페이지 h1은 하나 필요해 스크린리더용으로만 남긴다 */}
      <h1 className="srOnly">{name}님의 홈</h1>

      {consensus.length > 0 && (
        <>
          {/* 섹션 머리(제목·자산군 선택·카드 보기)는 히트맵 컴포넌트가 함께 그린다 */}
          <PredictionHeatmap consensus={consensus} />
          {/* 법적 방어 문구 — 시세·전망 화면으로 오해되지 않게 "예측의 집계"임을 명시 */}
          <p className={styles.consensusNote}>
            예측 히트맵은 리서처들이 게시한 예측을 종목별로 집계해 색으로 나타낸 것입니다.
            시세나 플랫폼의 전망·투자 권유가 아니며, 투자 판단의 책임은 이용자 본인에게
            있습니다.
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

      {/* 신고 배너는 홈에서 잔잔하게 맨 아래 — 강조는 리더보드(카드를 사는 자리)가 맡는다 */}
      <div className={styles.cleanBannerSlot}>
        <CleanBanner />
      </div>

    </main>
  );
}
