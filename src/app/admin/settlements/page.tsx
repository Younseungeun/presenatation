import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { getPendingPayouts, getPendingRefunds } from "@/server/settlementOpsService";
import { getSessionUserId } from "@/server/session";
import styles from "../../researcher/researcher.module.css";
import { ExecuteButton } from "./ExecuteButton";

export const dynamic = "force-dynamic";

// 운영자 정산 콘솔: 판정이 만든 환불·지급 지시서를 실행하고 기록한다.
// PG 취소·지급이체 자동화 전의 수동 운영 화면 — 비운영자에게는 404.

function fmtDate(d: Date) {
  return new Date(d).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

export default async function AdminSettlementsPage() {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const [refunds, payouts] = await Promise.all([
    getPendingRefunds(prisma),
    getPendingPayouts(prisma),
  ]);
  const refundTotal = refunds.reduce((a, s) => a + s.buyerRefundKrw, 0);
  const payoutTotal = payouts.reduce((a, s) => a + s.researcherPayoutKrw, 0);

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>정산 지시서</h1>
          <p className={styles.sub}>
            판정이 확정한 환불·지급을 실행하고 기록합니다. 실행 즉시 당사자에게 알림이
            갑니다. <Link href="/admin/judgments">판정 보류 큐 →</Link>
          </p>
        </div>
      </div>

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>미실행 환불</span>
          <span className={styles.statValue}>
            {refunds.length}건 · {refundTotal.toLocaleString()}원
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>미지급 정산</span>
          <span className={styles.statValue}>
            {payouts.length}건 · {payoutTotal.toLocaleString()}원
          </span>
        </div>
      </div>

      <h3>환불 지시서 (구매자 현금 환불)</h3>
      {refunds.length === 0 ? (
        <p className={styles.empty}>실행할 환불이 없습니다.</p>
      ) : (
        refunds.map((s) => (
          <div key={s.id} className={styles.card}>
            <div className={styles.cardTop}>
              <div className={styles.cardTitle}>
                {s.buyerRefundKrw.toLocaleString()}원 →{" "}
                {s.purchase.buyer.penName ?? s.purchase.buyer.email}
              </div>
              <span className={`${styles.badge} ${s.outcome === "MISS" ? styles.miss : styles.undecidable}`}>
                {s.outcome === "MISS" ? "예측 실패" : "판정 불가"}
              </span>
            </div>
            <div className={styles.meta}>
              <span>{s.purchase.report.title}</span>
              <span>판정 {fmtDate(s.settledAt)}</span>
              <span>결제 {fmtDate(s.purchase.paidAt)}</span>
            </div>
            <ExecuteButton kind="REFUND" settlementId={s.id} />
          </div>
        ))
      )}

      <h3>지급 지시서 (리서처 정산금)</h3>
      {payouts.length === 0 ? (
        <p className={styles.empty}>지급할 정산이 없습니다.</p>
      ) : (
        payouts.map((s) => (
          <div key={s.id} className={styles.card}>
            <div className={styles.cardTop}>
              <div className={styles.cardTitle}>
                {s.researcherPayoutKrw.toLocaleString()}원 →{" "}
                {s.purchase.report.researcher.user.penName ??
                  s.purchase.report.researcher.user.email}
              </div>
              <span className={`${styles.badge} ${styles.hit}`}>적중 정산</span>
            </div>
            <div className={styles.meta}>
              <span>{s.purchase.report.title}</span>
              <span>수수료 {s.platformFeeKrw.toLocaleString()}원</span>
              <span>판정 {fmtDate(s.settledAt)}</span>
            </div>
            <ExecuteButton kind="PAYOUT" settlementId={s.id} />
          </div>
        ))
      )}
    </main>
  );
}
