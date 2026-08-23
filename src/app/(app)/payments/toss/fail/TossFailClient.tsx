"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { reportIdFromOrderId } from "../reportIdFromOrderId";
import styles from "../../../market.module.css";

export function TossFailClient() {
  const params = useSearchParams();
  const message = params.get("message") ?? "결제가 진행되지 않았습니다.";
  const code = params.get("code");
  const reportId = reportIdFromOrderId(params.get("orderId"));

  return (
    <main className={styles.page}>
      <h1 className={styles.h1}>결제가 완료되지 않았습니다</h1>
      <p className={styles.sub}>
        {message}
        {code && ` (${code})`}
      </p>
      <Link
        href={reportId ? `/report/${reportId}` : "/leaderboard"}
        style={{ color: "var(--brand-strong)", fontWeight: 700 }}
      >
        {reportId ? "리포트로 돌아가 다시 시도하기 →" : "리더보드로 이동 →"}
      </Link>
    </main>
  );
}
