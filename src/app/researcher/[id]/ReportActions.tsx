"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../researcher.module.css";

// 게시·철회는 기존 API를 호출한다 (인증은 헤더 스텁).
export function ReportActions({
  researcherId,
  reportId,
  status,
}: {
  researcherId: string;
  reportId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "publish" | "withdraw") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/${action}`, {
        method: "POST",
        headers: { "x-researcher-id": researcherId },
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.issues ? body.issues.join(" / ") : body.error ?? "실패");
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
    <div className={styles.actions}>
      {status === "DRAFT" && (
        <button className={styles.actionBtn} disabled={busy} onClick={() => act("publish")}>
          게시하기
        </button>
      )}
      {status === "PUBLISHED" && (
        <button
          className={`${styles.actionBtn} ${styles.danger}`}
          disabled={busy}
          onClick={() => act("withdraw")}
        >
          철회
        </button>
      )}
      {error && <span className={styles.hint} style={{ color: "#c62828" }}>{error}</span>}
    </div>
  );
}
