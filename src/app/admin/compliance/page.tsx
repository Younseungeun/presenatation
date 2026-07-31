import Link from "next/link";
import { notFound } from "next/navigation";
import { RISK_CATEGORY_LABEL, type Finding, type RiskCategory } from "@/domain/compliance";
import {
  getPendingComplianceReviews,
  getPublishedReportsForOversight,
} from "@/server/complianceService";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import styles from "../../researcher/researcher.module.css";
import { ResolveButton } from "./ResolveButton";

export const dynamic = "force-dynamic";

// 운영자 컴플라이언스 큐: 게시는 허용됐지만 검토가 필요한 건(WARN)과
// AI 검수가 실패해 확인이 필요한 건(UNAVAILABLE). 비운영자에게는 404.

function parseFindings(json: string): Finding[] {
  try {
    return JSON.parse(json) as Finding[];
  } catch {
    return [];
  }
}

export default async function AdminCompliancePage() {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const [pending, published] = await Promise.all([
    getPendingComplianceReviews(prisma),
    getPublishedReportsForOversight(prisma),
  ]);

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>컴플라이언스 검토</h1>
          <p className={styles.sub}>
            2단 검수(금지 표현 규칙 → AI 판단)로 결론이 나지 않아 <strong>게시가 보류된</strong>{" "}
            리포트입니다. 명백한 위반은 게시 시도 자체가 차단되므로 여기에 올라오지 않습니다.
            운영자가 <strong>게시 승인</strong> 또는 <strong>반려</strong>를 결정할 때까지 판매는
            시작되지 않습니다.{" "}
            <Link href="/admin/judgments">판정 보류 큐 →</Link>
          </p>
        </div>
      </div>

      {pending.length === 0 ? (
        <p className={styles.empty}>검토할 건이 없습니다.</p>
      ) : (
        pending.map((review) => {
          const findings = parseFindings(review.findingsJson);
          const researcher = review.report.researcher.user;
          const held = review.report.purchases;
          const heldAmountKrw = held.reduce((sum, p) => sum + p.amountKrw, 0);
          return (
            <div key={review.id} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.cardTitle}>{review.report.title}</div>
                <span
                  className={`${styles.badge} ${
                    review.decision === "UNAVAILABLE" ? styles.undecidable : styles.miss
                  }`}
                >
                  {review.report.status === "PENDING_REVIEW" ? "게시 대기" : "게시 중"} ·{" "}
                  {review.decision === "UNAVAILABLE"
                    ? "검수 실패"
                    : review.decision === "BLOCK"
                      ? "AI 위반 판정"
                      : "AI 경고"}
                </span>
              </div>
              <div className={styles.meta}>
                <span>{researcher.penName ?? researcher.email}</span>
                <span>검수 {review.reviewer}</span>
                <span>{new Date(review.createdAt).toLocaleString("ko-KR")}</span>
                <span>
                  {review.report.status === "PENDING_REVIEW"
                    ? "게시 보류 — 판매 전"
                    : review.report.status === "PUBLISHED"
                      ? `판매 중 · 에스크로 ${held.length}건 ${heldAmountKrw.toLocaleString()}원`
                      : "판매 종료"}
                </span>
                <Link href={`/report/${review.report.id}`}>본문 보기 →</Link>
              </div>

              {review.decision === "UNAVAILABLE" ? (
                <p className={styles.hint}>
                  AI 검수가 실패해 결정적 규칙만 적용된 상태입니다. 본문을 직접 확인해주세요.
                </p>
              ) : (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13.5 }}>
                  {findings.map((f, i) => (
                    <li key={i} style={{ marginBottom: 6, color: "var(--text-weak)" }}>
                      <span
                        className={`${styles.badge} ${
                          f.severity === "BLOCK" ? styles.miss : styles.undecidable
                        }`}
                        style={{ marginRight: 6 }}
                      >
                        {f.severity === "BLOCK" ? "위반" : "확인 필요"}
                      </span>
                      <strong>{RISK_CATEGORY_LABEL[f.category as RiskCategory]}</strong> —{" "}
                      {f.reason}
                      <br />
                      <span style={{ color: "var(--text-faint)" }}>&ldquo;{f.quote}&rdquo;</span>
                    </li>
                  ))}
                </ul>
              )}

              <ResolveButton
                reviewId={review.id}
                reportId={review.report.id}
                reportStatus={review.report.status}
                heldPurchases={held.length}
                heldAmountKrw={heldAmountKrw}
              />
            </div>
          );
        })
      )}

      {/* 승인 후 문제가 드러난 리포트를 내리는 경로 — 검토 큐에는 보류 건만 올라온다 */}
      <div className={styles.header} style={{ marginTop: 32 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800 }}>판매 중 리포트</h2>
          <p className={styles.sub}>
            검토를 통과해 판매 중인 리포트입니다. 사후에 위반이 확인되면 강제 철회로 게시를
            중단하고 구매자에게 전액 환불할 수 있습니다.
          </p>
        </div>
      </div>
      {published.length === 0 ? (
        <p className={styles.empty}>판매 중인 리포트가 없습니다.</p>
      ) : (
        published.map((report) => {
          const heldAmountKrw = report.purchases.reduce((sum, p) => sum + p.amountKrw, 0);
          const author = report.researcher.user;
          return (
            <div key={report.id} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.cardTitle}>{report.title}</div>
                <span className={`${styles.badge} ${styles.published}`}>판매 중</span>
              </div>
              <div className={styles.meta}>
                <span>{author.penName ?? author.email}</span>
                <span>
                  {report.publishedAt
                    ? new Date(report.publishedAt).toLocaleDateString("ko-KR")
                    : "-"}
                </span>
                <span>
                  에스크로 {report.purchases.length}건 {heldAmountKrw.toLocaleString()}원
                </span>
                <Link href={`/report/${report.id}`}>본문 보기 →</Link>
              </div>
              <ResolveButton
                reportId={report.id}
                reportStatus={report.status}
                heldPurchases={report.purchases.length}
                heldAmountKrw={heldAmountKrw}
              />
            </div>
          );
        })
      )}
    </main>
  );
}
