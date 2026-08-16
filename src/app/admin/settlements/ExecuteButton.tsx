"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import styles from "../../researcher/researcher.module.css";

// 지시서 실행 버튼: 환불은 방법(PG 취소/계좌이체)을 골라 실행, 지급은 바로 실행.
// 실행은 되돌릴 수 없으므로 confirm 한 번을 거친다.
//
// **끝나지 않은 시도(stuckAttempt)가 있으면 "새로 실행"을 아예 내보내지 않는다.**
// PENDING은 "돈이 나갔는지 우리가 모른다"는 뜻이라, 새로 실행하면 새 키로 한 번 더 나가
// 두 번 빠질 수 있다. 다만 **이어받는 방법이 수단마다 다르다**:
//
//  · PG 취소 → **재시도.** 멱등키가 있어 같은 키로 다시 보내면 결과는 한 번이다
//  · 계좌이체 → **상태 확정.** 사람이 은행 앱에서 보낸 돈에는 멱등키가 없다. 여기서
//    "재시도"를 내보내면 운영자가 "안 나갔구나" 하고 한 번 더 보낼 수 있고 그게 곧
//    이중 송금이다. 그래서 물어보는 것은 하나뿐이다 — **실제로 보내셨습니까**
export function ExecuteButton({
  kind,
  settlementId,
  stuckAttemptId,
  stuckAttemptMethod,
}: {
  kind: "REFUND" | "PAYOUT";
  settlementId: string;
  stuckAttemptId?: string;
  stuckAttemptMethod?: string;
}) {
  const router = useRouter();
  const [method, setMethod] = useState("PG_CANCEL");
  const [bankReference, setBankReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stuck = kind === "REFUND" && !!stuckAttemptId;
  const resolving = stuck && stuckAttemptMethod === "BANK_TRANSFER";
  const retrying = stuck && !resolving;
  // 새 계좌이체 실행이거나, 멈춘 계좌이체를 "보냈다"로 닫을 때 참조번호가 필요하다
  const needsReference = resolving || (kind === "REFUND" && !stuck && method === "BANK_TRANSFER");

  async function post(body: unknown, question: string, retried = false) {
    if (!retried && !window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settlements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "RECHECK_REQUIRED" && !retried) {
          // 1인 운영 모드의 고액 지급 — 지문 1초가 흐름을 끊는 물리적 브레이크다
          // (검토 6차 Q2). 확인되면 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok) {
            await post(body, question, true);
            return;
          }
          if (recheck.error) setError(recheck.error);
          return;
        }
        setError(json.error ?? "실행 실패");
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    const label = kind === "REFUND" ? "환불" : "지급";
    if (needsReference && bankReference.trim() === "") {
      setError(
        "은행 이체 참조번호를 입력해주세요 — 계좌이체는 중복 송금을 시스템이 막을 수 없습니다.",
      );
      return;
    }
    if (retrying) {
      return post(
        { kind: "REFUND_RETRY", attemptId: stuckAttemptId },
        "끝나지 않은 PG 취소를 같은 키로 다시 보낼까요? 이미 나갔다면 중복되지 않습니다.",
      );
    }
    if (resolving) {
      return post(
        {
          kind: "REFUND_RESOLVE",
          attemptId: stuckAttemptId,
          resolution: "SENT",
          bankReference: bankReference.trim(),
        },
        "이 이체를 완료로 확정할까요? 은행 앱에서 실제로 보낸 것이 맞는지 먼저 확인해주세요.",
      );
    }
    return post(
      kind === "REFUND"
        ? {
            kind,
            settlementId,
            method,
            ...(needsReference ? { bankReference: bankReference.trim() } : {}),
          }
        : { kind, settlementId },
      `${label}을 실행 완료로 기록할까요? 되돌릴 수 없습니다.`,
    );
  }

  /** 계좌이체를 "안 보냈다"로 닫는다 — 새 시도를 만들 수 있게 풀어 준다 */
  async function markNotSent() {
    return post(
      { kind: "REFUND_RESOLVE", attemptId: stuckAttemptId, resolution: "NOT_SENT" },
      "이체하지 않은 것으로 확정할까요? 이 건은 다시 환불 실행 대상이 됩니다.",
    );
  }

  return (
    <div className={styles.formActions}>
      {kind === "REFUND" && !stuck && (
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
            ? "미완료 PG 취소 재시도"
            : resolving
              ? "이체 완료로 확정"
              : kind === "REFUND"
                ? "환불 실행 완료"
                : "지급 실행 완료"}
      </button>
      {resolving && (
        <button className={styles.secondaryBtn} onClick={markNotSent} disabled={busy}>
          이체하지 않았습니다
        </button>
      )}
      {retrying && (
        <p className={styles.sub}>
          앞선 시도의 PG 응답을 받지 못했습니다. 같은 키로 다시 보내므로 이미 나갔다면
          중복되지 않습니다.
        </p>
      )}
      {resolving && (
        <p className={styles.sub}>
          계좌이체는 자동 재시도할 수 없습니다(멱등키가 없어 재시도가 곧 이중 송금입니다).
          <strong> 은행 앱에서 이체 여부를 먼저 확인</strong>한 뒤 상태를 골라주세요.
        </p>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
