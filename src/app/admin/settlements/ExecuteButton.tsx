"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher/researcher.module.css";

// 지시서 실행 버튼: 환불은 방법(PG 취소/계좌이체)을 골라 실행, 지급은 바로 실행.
// 실행은 되돌릴 수 없으므로 confirm 한 번을 거친다.
export function ExecuteButton({
  kind,
  settlementId,
}: {
  kind: "REFUND" | "PAYOUT";
  settlementId: string;
}) {
  const router = useRouter();
  const [method, setMethod] = useState("PG_CANCEL");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function execute() {
    const label = kind === "REFUND" ? "환불" : "지급";
    if (!window.confirm(`${label}을 실행 완료로 기록할까요? 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settlements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          kind === "REFUND" ? { kind, settlementId, method } : { kind, settlementId },
        ),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "실행 실패");
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
      {kind === "REFUND" && (
        <select
          className={styles.select}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          style={{ maxWidth: 220 }}
        >
          <option value="PG_CANCEL">PG 결제 취소</option>
          <option value="BANK_TRANSFER">계좌이체 (취소 기한 초과)</option>
        </select>
      )}
      <button className={styles.primaryBtn} onClick={execute} disabled={busy}>
        {busy ? "기록 중…" : kind === "REFUND" ? "환불 실행 완료" : "지급 실행 완료"}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
