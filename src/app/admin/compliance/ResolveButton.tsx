"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher/researcher.module.css";

// 검토 완료 처리 — 큐에서 제거하고 확인한 운영자·시각을 기록한다.
export function ResolveButton({ reviewId }: { reviewId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "처리 실패");
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
    <div className={styles.formActions}>
      <button className={styles.primaryBtn} onClick={resolve} disabled={busy}>
        {busy ? "처리 중…" : "검토 완료"}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
