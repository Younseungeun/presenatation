"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher/researcher.module.css";

// 지시서 실행 버튼: 환불은 방법(PG 취소/계좌이체)을 골라 실행, 지급은 바로 실행.
// 실행은 되돌릴 수 없으므로 confirm 한 번을 거친다.
//
// **끝나지 않은 시도(stuckAttemptId)가 있으면 "새로 실행"을 아예 내보내지 않는다.**
// PENDING은 "취소가 나갔는지 우리가 모른다"는 뜻이라, 새로 실행하면 새 멱등키로 한 번 더
// 나가 두 번 빠질 수 있다. 그 시도를 같은 키로 이어받는 재시도만 남긴다.
export function ExecuteButton({
  kind,
  settlementId,
  stuckAttemptId,
}: {
  kind: "REFUND" | "PAYOUT";
  settlementId: string;
  stuckAttemptId?: string;
}) {
  const router = useRouter();
  const [method, setMethod] = useState("PG_CANCEL");
  const [bankReference, setBankReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retrying = kind === "REFUND" && !!stuckAttemptId;
  const needsReference = kind === "REFUND" && !retrying && method === "BANK_TRANSFER";

  async function execute() {
    const label = kind === "REFUND" ? "환불" : "지급";
    if (needsReference && bankReference.trim() === "") {
      setError("은행 이체 참조번호를 입력해주세요 — 계좌이체는 중복 송금을 시스템이 막을 수 없습니다.");
      return;
    }
    const question = retrying
      ? "끝나지 않은 환불 시도를 같은 키로 다시 보낼까요? 이미 나갔다면 중복되지 않습니다."
      : `${label}을 실행 완료로 기록할까요? 되돌릴 수 없습니다.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settlements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          retrying
            ? { kind: "REFUND_RETRY", attemptId: stuckAttemptId }
            : kind === "REFUND"
              ? {
                  kind,
                  settlementId,
                  method,
                  ...(needsReference ? { bankReference: bankReference.trim() } : {}),
                }
              : { kind, settlementId },
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
      {kind === "REFUND" && !retrying && (
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
      {/* 계좌이체에는 멱등키가 없다 — 은행에서 이미 보낸 이체를 시스템이 알 방법이
          이 번호뿐이고, 입력을 요구하는 것 자체가 운영자를 은행 앱으로 되돌려 보낸다 */}
      {needsReference && (
        <input
          className={styles.input}
          value={bankReference}
          onChange={(e) => setBankReference(e.target.value)}
          placeholder="은행 이체 참조번호"
          style={{ maxWidth: 220 }}
        />
      )}
      <button className={styles.primaryBtn} onClick={execute} disabled={busy}>
        {busy
          ? "기록 중…"
          : retrying
            ? "미완료 환불 재시도"
            : kind === "REFUND"
              ? "환불 실행 완료"
              : "지급 실행 완료"}
      </button>
      {retrying && (
        <p className={styles.sub}>
          앞선 시도의 PG 응답을 받지 못했습니다. 같은 키로 다시 보내므로 이미 나갔다면
          중복되지 않습니다.
        </p>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
