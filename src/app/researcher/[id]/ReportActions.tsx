"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../researcher.module.css";

// 게시·철회는 API를 호출한다 (인증은 세션, 소유권은 서버가 검증).
export function ReportActions({
  reportId,
  status,
}: {
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
      const res = await fetch(`/api/reports/${reportId}/${action}`, { method: "POST" });
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
      {status === "PENDING_REVIEW" && (
        <span className={styles.hint}>
          자동 검수에서 확인이 필요한 표현이 있어 운영자 검토 중입니다. 승인되면 판매가
          시작됩니다.
        </span>
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
