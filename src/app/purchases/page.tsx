import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { getBuyerPurchases, type BuyerPurchase } from "@/server/financeQueries";
import { getSessionUserId } from "@/server/session";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

// 구매 상태를 사용자 언어로: 보관 중 → 판정 결과 → 환불/정산
function statusOf(p: BuyerPurchase): { label: string; cls: string } {
  const judgment = p.report.predictionCard?.judgment;
  if (!p.settlement || !judgment) {
    return { label: "판정 대기 (에스크로 보관 중)", cls: styles.badgeUndecidable };
  }
  if (judgment.outcome === "HIT") {
    return { label: "적중 — 정산 완료", cls: styles.badgeHit };
  }
  if (judgment.outcome === "MISS") {
    return {
      label: `실패 — ${p.settlement.buyerRefundKrw.toLocaleString()}원 환불`,
      cls: styles.badgeMiss,
    };
  }
  return { label: "판정 불가 — 전액 환불", cls: styles.badgeUndecidable };
}

export default async function PurchasesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login?next=/purchases");

  const purchases = await getBuyerPurchases(prisma, userId);

  return (
    <main className={styles.page}>
      <h1 className={styles.h1}>구매 내역</h1>
      <p className={styles.sub}>
        결제 금액은 판정 전까지 에스크로에 보관되고, 예측이 틀리면 성과 연동분이 현금으로
        환불됩니다.
      </p>

      {purchases.length === 0 ? (
        <p className={styles.sub}>
          아직 구매한 리포트가 없습니다.{" "}
          <Link href="/leaderboard" style={{ color: "var(--brand-strong)", fontWeight: 700 }}>
            리더보드에서 리서처 찾기 →
          </Link>
        </p>
      ) : (
        purchases.map((p) => {
          const s = statusOf(p);
          const researcherName =
            p.report.researcher.user.penName ?? p.report.researcher.user.email;
          return (
            <Link key={p.id} href={`/report/${p.reportId}`} className={styles.reportCard}>
              <div className={styles.reportTitle}>
                {p.report.title} <span className={s.cls}>{s.label}</span>
              </div>
              <div className={styles.meta}>
                <span>{researcherName}</span>
                <span>{p.amountKrw.toLocaleString()}원</span>
                <span>{new Date(p.paidAt).toLocaleDateString("ko-KR")} 결제</span>
                {p.report.predictionCard && (
                  <span>
                    시한{" "}
                    {new Date(p.report.predictionCard.deadline).toLocaleDateString("ko-KR")}
                  </span>
                )}
              </div>
            </Link>
          );
        })
      )}
    </main>
  );
}
