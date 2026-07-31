"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher/researcher.module.css";

// 검토 큐의 두 가지 집행 액션.
//  - 검토 완료: 문제 없음 확인 → 큐에서 제거 (기록만 남음)
//  - 강제 철회: 실제 위반 → 게시 중단 + 즉시 전액 환불. 되돌릴 수 없으므로
//    사유 입력과 확인 단계를 거치게 한다.
export function ResolveButton({
  reviewId,
  reportId,
  canTakedown,
  heldPurchases,
  heldAmountKrw,
}: {
  reviewId: string;
  reportId: string;
  /** 게시 중(PUBLISHED)인 리포트만 강제 철회 대상 */
  canTakedown: boolean;
  heldPurchases: number;
  heldAmountKrw: number;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"IDLE" | "TAKEDOWN">("IDLE");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, failMessage: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.error ?? failMessage);
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (mode === "TAKEDOWN") {
    return (
      <div className={styles.form}>
        <p className={styles.hint}>
          게시가 중단되고 예측 카드는 판정 불가(철회)로 확정됩니다.
          {heldPurchases > 0
            ? ` 구매 ${heldPurchases}건 ${heldAmountKrw.toLocaleString()}원이 전액 환불되고, 리서처 정산과 플랫폼 수수료는 발생하지 않습니다.`
            : " 아직 구매 건이 없어 환불 대상은 없습니다."}{" "}
          이 카드는 리서처 점수에 반영되지 않습니다. 되돌릴 수 없습니다.
        </p>
        <label className={styles.field}>
          <span className={styles.label}>강제 철회 사유 (리서처에게 통지, 필수)</span>
          <textarea
            className={styles.textarea}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="예: 출처 불명 풍문을 근거로 제시 — 공개 자료 확인 불가"
          />
        </label>
        <div className={styles.formActions}>
          <button
            className={`${styles.actionBtn} ${styles.danger}`}
            onClick={() => post({ action: "TAKEDOWN", reportId, reason }, "철회 실패")}
            disabled={busy || !reason.trim()}
          >
            {busy ? "처리 중…" : "강제 철회 실행"}
          </button>
          <button
            className={styles.actionBtn}
            onClick={() => {
              setMode("IDLE");
              setError(null);
            }}
            disabled={busy}
          >
            취소
          </button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    );
  }

  return (
    <div className={styles.formActions}>
      <button
        className={styles.primaryBtn}
        onClick={() => post({ action: "RESOLVE", reviewId }, "처리 실패")}
        disabled={busy}
      >
        {busy ? "처리 중…" : "검토 완료"}
      </button>
      {canTakedown && (
        <button
          className={`${styles.actionBtn} ${styles.danger}`}
          onClick={() => setMode("TAKEDOWN")}
          disabled={busy}
        >
          강제 철회
        </button>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
