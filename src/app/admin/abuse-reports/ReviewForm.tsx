"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher/researcher.module.css";

// 신고 검토 폼 — 확인/기각 + 사유. 처리 후 목록을 새로 고친다.

export function ReviewForm({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"CONFIRMED" | "REJECTED" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const review = async (decision: "CONFIRMED" | "REJECTED") => {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch("/api/admin/abuse-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reportId, decision, note }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "처리에 실패했습니다");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "처리에 실패했습니다");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.form}>
      <label className={styles.label}>
        검토 사유 (확인·기각 공통, 기록에 남습니다)
        <input
          className={styles.input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="예: 리포트 본문에 오픈채팅 유도 문구 확인 / 근거 불충분"
          maxLength={2000}
        />
      </label>
      {error && <p className={styles.error}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className={styles.primaryBtn}
          disabled={busy !== null || note.trim().length === 0}
          onClick={() => review("CONFIRMED")}
        >
          {busy === "CONFIRMED" ? "처리 중…" : "위반 확인 (보상 대상)"}
        </button>
        <button
          type="button"
          className={styles.primaryBtn}
          style={{ background: "var(--surface-2)", color: "var(--text)" }}
          disabled={busy !== null || note.trim().length === 0}
          onClick={() => review("REJECTED")}
        >
          {busy === "REJECTED" ? "처리 중…" : "기각"}
        </button>
      </div>
    </div>
  );
}
