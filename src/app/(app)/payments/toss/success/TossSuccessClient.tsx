"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { reportIdFromOrderId } from "../reportIdFromOrderId";
import styles from "../../../market.module.css";

/**
 * 결제창 successUrl 도착 지점 — 아직 "결제 인증"만 끝난 상태다.
 * 여기서 서버에 승인(confirm)을 요청해야 실제로 완료된다(토스페이먼츠 필수 절차).
 */
export function TossSuccessClient() {
  const params = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<"confirming" | "done" | "error">("confirming");
  const [error, setError] = useState<string | null>(null);

  const orderId = params.get("orderId");
  const paymentKey = params.get("paymentKey");
  const amount = params.get("amount");
  const fallbackReportId = reportIdFromOrderId(orderId);
  const paramsInvalid = !orderId || !paymentKey || !amount;

  useEffect(() => {
    if (paramsInvalid) return;
    (async () => {
      try {
        const res = await fetch("/api/payments/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId, paymentKey, amount: Number(amount) }),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "결제 승인에 실패했습니다");
          setState("error");
          return;
        }
        setState("done");
        router.replace(`/report/${body.reportId}`);
      } catch (e) {
        setError((e as Error).message);
        setState("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (paramsInvalid || state === "error") {
    return (
      <main className={styles.page}>
        <h1 className={styles.h1}>결제 승인 실패</h1>
        <p className={styles.sub}>{error ?? "결제 응답이 올바르지 않습니다."}</p>
        <Link
          href={fallbackReportId ? `/report/${fallbackReportId}` : "/my"}
          style={{ color: "var(--brand-strong)", fontWeight: 700 }}
        >
          {fallbackReportId ? "리포트로 돌아가기 →" : "MY로 이동 →"}
        </Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.h1}>결제 승인 확인 중…</h1>
      <p className={styles.sub}>잠시만 기다려주세요.</p>
    </main>
  );
}
