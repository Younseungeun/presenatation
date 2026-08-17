"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import styles from "../../researcher/researcher.module.css";

// ⚠ 디자인 보류 — 기능 검증용 최소 형태다 (docs/design-backlog.md).
//
// 플랫폼 귀책 보상의 두 동작. 확정과 실행을 한 버튼으로 합치지 않는다 —
// 확정은 "우리 탓인가"라는 **판단**이고 실행은 은행 이체 뒤의 **기록**이라,
// 합치면 이체도 안 했는데 실행된 것으로 기록하는 길이 생긴다.

/** 귀책 확정 — 보상(APPROVE) 또는 대상 제외(EXCLUDE, 사유 필수). 확정 직전 지문 확인 */
export function CompensationReview({ predictionCardId }: { predictionCardId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "APPROVE" | "EXCLUDE", recheckToken?: string) {
    if (decision === "EXCLUDE" && !note.trim()) {
      setError("보상 대상에서 빼려면 사유를 적어주세요 (예: 거래소 공지 확인 — 당일 거래정지)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compensations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "REVIEW",
          predictionCardId,
          decision,
          note: note.trim() || undefined,
          ...(recheckToken ? { recheckToken } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 확정에도 지문이 선다 — 실행에만 걸면 훔친 세션이 승인만 눌러 두는
          // "잠복 승인"이 남는다 (1인 모드에서는 확정자와 실행자가 같은 계정이라
          // 이체 대기 목록이 낯선 승인을 걸러 주지 못한다)
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await decide(decision, recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
          return;
        }
        setError(body.error ?? "확정 실패");
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
    <div className={styles.form}>
      <label className={styles.field}>
        <span className={styles.label}>확인한 내용 (제외 시 필수)</span>
        <input
          className={styles.input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="예: 거래소 공지 확인 — 그날 거래정지 없었음 (우리 피드 장애)"
        />
      </label>
      <div className={styles.formActions}>
        <button className={styles.secondaryBtn} onClick={() => decide("EXCLUDE")} disabled={busy}>
          대상 아님 (종목 사정)
        </button>
        <button className={styles.primaryBtn} onClick={() => decide("APPROVE")} disabled={busy}>
          {busy ? "확정 중…" : "우리 귀책 — 보상 승인"}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}

/** 보상 실행 기록 — 은행 이체를 먼저 하고, 참조번호로 닫는다. 실행 직전 지문 확인 */
export function CompensationExecute({ compensationId }: { compensationId: string }) {
  const router = useRouter();
  const [bankReference, setBankReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(recheckToken?: string) {
    if (!bankReference.trim()) {
      setError("은행 이체 참조번호를 입력해주세요 — 이체를 먼저 실행하고 그 번호가 유일한 증명입니다.");
      return;
    }
    if (
      !recheckToken &&
      !window.confirm("이 보상을 실행 완료로 기록할까요? 은행에서 실제로 보낸 것이 맞는지 먼저 확인해주세요.")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compensations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "EXECUTE",
          compensationId,
          bankReference: bankReference.trim(),
          ...(recheckToken ? { recheckToken } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 플랫폼 자본이 나가는 길 — 금액과 무관하게 지문이 선다 (연 몇 건이라
          // 경보 피로가 없고, 이 한 점을 지나야 복구 뒤 48시간 정지도 여기까지 덮는다)
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await post(recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
          return;
        }
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
    <div className={styles.form}>
      <div className={styles.formActions}>
        <input
          className={styles.input}
          value={bankReference}
          onChange={(e) => setBankReference(e.target.value)}
          placeholder="은행 이체 참조번호"
          style={{ maxWidth: 220 }}
        />
        <button className={styles.primaryBtn} onClick={() => post()} disabled={busy}>
          {busy ? "기록 중…" : "보상 실행 완료"}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
