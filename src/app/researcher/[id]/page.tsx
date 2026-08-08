import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { getResearcherFinance } from "@/server/financeQueries";
import { getResearcherDashboard, type DashboardReport } from "@/server/reportQueries";
import { AppHeader } from "../../AppHeader";
import { EmptyState } from "../../EmptyState";
import { cardLine, fmtDate } from "../../format";
import { StatusChip, outcomeStatus, type StatusKind } from "../../StatusChip";
import { TierChip } from "../../TierChip";
import { ReportActions } from "./ReportActions";
import styles from "../researcher.module.css";

export const dynamic = "force-dynamic";

function StatusBadge({ report }: { report: DashboardReport }) {
  const j = report.predictionCard?.judgment;
  if (j) return <StatusChip status={outcomeStatus(j.outcome)} />;
  // 상태 칩은 StatusChip으로 일원화돼 있다 (시각 언어 통일) — 새 상태는 거기에 더한다
  const map: Record<string, StatusKind> = {
    DRAFT: "DRAFT",
    PENDING_REVIEW: "PENDING_REVIEW",
    PUBLISHED: "SELLING",
    CLOSED: "ENDED",
  };
  return <StatusChip status={map[report.status] ?? "DRAFT"} />;
}

function cardSummary(report: DashboardReport): string | null {
  const c = report.predictionCard;
  if (!c) return null;
  return `${cardLine(c)} (${c.ticker}) · 시한 ${fmtDate(c.deadline)} · 신뢰도 ${c.confidence}`;
}

export default async function ResearcherDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getResearcherDashboard(prisma, id);
  if (!data) notFound();
  const finance = await getResearcherFinance(prisma, id);

  const name = data.user.penName ?? data.user.email;
  const payoutByReport = new Map(finance.byReport.map((r) => [r.reportId, r]));

  return (
    <>
      <AppHeader title="내 리포트·정산" titleAs="span" backHref="/my?mode=seller" />
      <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>{name}</h1>
          <TierChip tier={data.tier} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className={styles.actionBtn} href={`/researcher/${id}/free`}>
            무료 시황 쓰기
          </Link>
          <Link className={styles.primaryBtn} href={`/researcher/${id}/new`}>
            + 새 리포트 작성
          </Link>
        </div>
      </div>
      <p className={styles.sub}>
        리포트 {data.reports.length}건 · 게시하면 예측 카드가 잠기고 판정·정산이 자동으로
        진행됩니다.
      </p>

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>누적 판매</div>
          <div className={styles.statValue}>{finance.totals.salesCount}건</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>에스크로 보관 중</div>
          <div className={styles.statValue}>{finance.totals.heldKrw.toLocaleString()}원</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>확정 정산액</div>
          <div className={styles.statValue} style={{ color: "var(--pos)" }}>
            {finance.totals.payoutKrw.toLocaleString()}원
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>구매자 환불</div>
          <div className={styles.statValue}>{finance.totals.refundedKrw.toLocaleString()}원</div>
        </div>
      </div>

      {data.reports.length === 0 ? (
        <EmptyState
          title="아직 작성한 리포트가 없어요"
          body="예측 카드를 붙여 게시하면 판정 결과가 트랙레코드로 쌓입니다."
          actionHref={`/researcher/${id}/new`}
          actionLabel="첫 리포트 쓰기"
        />
      ) : (
        data.reports.map((report) => (
          <div key={report.id} className={styles.card}>
            <div className={styles.cardTop}>
              <div>
                <div className={styles.cardTitle}>{report.title}</div>
                <div className={styles.hint}>{report.summary}</div>
              </div>
              <StatusBadge report={report} />
            </div>
            <div className={styles.meta}>
              {cardSummary(report) && <span>{cardSummary(report)}</span>}
            </div>
            <div className={styles.meta}>
              <span>{report.priceKrw.toLocaleString()}원</span>
              <span>선결제 {report.prepaymentRatio}%</span>
              {report.feeRateBp != null && <span>수수료 {report.feeRateBp / 100}%</span>}
              <span>구매 {report._count.purchases}건</span>
              {(() => {
                const f = payoutByReport.get(report.id);
                if (!f) return null;
                return (
                  <>
                    {f.heldKrw > 0 && <span>보관 {f.heldKrw.toLocaleString()}원</span>}
                    {f.payoutKrw > 0 && (
                      <span style={{ color: "var(--pos)", fontWeight: 700 }}>
                        정산 {f.payoutKrw.toLocaleString()}원
                      </span>
                    )}
                    {f.refundedKrw > 0 && <span>환불 {f.refundedKrw.toLocaleString()}원</span>}
                  </>
                );
              })()}
            </div>
            <ReportActions reportId={report.id} status={report.status} />
          </div>
        ))
      )}
      </main>
    </>
  );
}
