"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../market.module.css";

/**
 * 구매 버튼. 로그인(본인 인증)이 없으면 /login으로 유도한다.
 * 구매는 에스크로 보관 — 판정 후 적중이면 리서처 정산, 실패면 현금 환불.
 */
export function PurchaseButton({
  reportId,
  priceKrw,
  hasIdentity,
}: {
  reportId: string;
  priceKrw: number;
  hasIdentity: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function purchase() {
    if (!hasIdentity) {
      router.push(`/login?next=/report/${reportId}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/purchase`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "구매 실패");
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className={styles.primaryBtn} onClick={purchase} disabled={busy}>
        {busy
          ? "결제 중…"
          : hasIdentity
            ? `${priceKrw.toLocaleString()}원 결제하고 열람`
            : "본인 인증하고 구매하기"}
      </button>
      {error && <p className={styles.err}>{error}</p>}
    </div>
  );
}
