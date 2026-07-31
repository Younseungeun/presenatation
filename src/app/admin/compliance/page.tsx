import Link from "next/link";
import { notFound } from "next/navigation";
import { RISK_CATEGORY_LABEL, type Finding, type RiskCategory } from "@/domain/compliance";
import { getPendingComplianceReviews } from "@/server/complianceService";
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

  const pending = await getPendingComplianceReviews(prisma);

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>컴플라이언스 검토</h1>
          <p className={styles.sub}>
            게시는 허용됐지만 확인이 필요한 리포트입니다. 명백한 위반은 게시 시점에 자동
            차단되므로 여기에는 올라오지 않습니다.{" "}
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
          return (
            <div key={review.id} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.cardTitle}>{review.report.title}</div>
                <span
                  className={`${styles.badge} ${
                    review.decision === "UNAVAILABLE" ? styles.undecidable : styles.miss
                  }`}
                >
                  {review.decision === "UNAVAILABLE" ? "검수 실패" : "검토 필요"}
                </span>
              </div>
              <div className={styles.meta}>
                <span>{researcher.penName ?? researcher.email}</span>
                <span>검수 {review.reviewer}</span>
                <span>{new Date(review.createdAt).toLocaleDateString("ko-KR")}</span>
                <Link href={`/report/${review.report.id}`}>리포트 보기 →</Link>
              </div>

              {review.decision === "UNAVAILABLE" ? (
                <p className={styles.hint}>
                  AI 검수가 실패해 결정적 규칙만 적용된 상태로 게시됐습니다. 본문을 직접
                  확인해주세요.
                </p>
              ) : (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13.5 }}>
                  {findings.map((f, i) => (
                    <li key={i} style={{ marginBottom: 6, color: "var(--text-weak)" }}>
                      <strong>{RISK_CATEGORY_LABEL[f.category as RiskCategory]}</strong> —{" "}
                      {f.reason}
                      <br />
                      <span style={{ color: "var(--text-faint)" }}>&ldquo;{f.quote}&rdquo;</span>
                    </li>
                  ))}
                </ul>
              )}

              <ResolveButton reviewId={review.id} />
            </div>
          );
        })
      )}
    </main>
  );
}
