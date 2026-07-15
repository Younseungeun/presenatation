import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { getResearcherFinance } from "@/server/financeQueries";
import { getResearcherDashboard, type DashboardReport } from "@/server/reportQueries";
import { ReportActions } from "./ReportActions";
import styles from "../researcher.module.css";

export const dynamic = "force-dynamic";

const ASSET_LABEL: Record<string, string> = {
  KR_EQUITY: "국내주식",
  US_EQUITY: "미국주식",
  CRYPTO: "코인",
};

function StatusBadge({ report }: { report: DashboardReport }) {
  const j = report.predictionCard?.judgment;
  if (j) {
    const cls =
      j.outcome === "HIT" ? styles.hit : j.outcome === "MISS" ? styles.miss : styles.undecidable;
    const label = j.outcome === "HIT" ? "적중" : j.outcome === "MISS" ? "실패" : "판정 불가";
    return <span className={`${styles.badge} ${cls}`}>{label}</span>;
  }
  const map: Record<string, [string, string]> = {
    DRAFT: [styles.draft, "초안"],
    PUBLISHED: [styles.published, "판매 중"],
    CLOSED: [styles.closed, "종료"],
  };
  const [cls, label] = map[report.status] ?? [styles.draft, report.status];
  return <span className={`${styles.badge} ${cls}`}>{label}</span>;
}

function cardSummary(report: DashboardReport): string | null {
  const c = report.predictionCard;
  if (!c) return null;
  const dir = c.direction === "UP" ? "▲ 상승" : "▼ 하락";
  const size =
    c.targetType === "RETURN_PCT"
      ? `${c.targetValue}%`
      : `목표가 ${c.targetValue.toLocaleString()}`;
  const deadline = new Date(c.deadline).toLocaleDateString("ko-KR");
  return `${ASSET_LABEL[c.assetClass] ?? c.assetClass} ${c.assetName}(${c.ticker}) · ${dir} ${size} · 시한 ${deadline} · 신뢰도 ${c.confidence}`;
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
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>{name}</h1>
          <span className={styles.tier}>{data.tier}</span>
        </div>
        <Link className={styles.primaryBtn} href={`/researcher/${id}/new`}>
          + 새 리포트 작성
        </Link>
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
        <div className={styles.empty}>
          아직 작성한 리포트가 없습니다. 첫 리포트를 작성해보세요.
        </div>
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
  );
}
