"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher/researcher.module.css";

// 2단 검수로 결론이 나지 않은 건에 대한 운영자의 최종 결정.
//
// 보류(PENDING_REVIEW) — 아직 판매 전이므로 환불 문제가 없다
//   · 게시 승인: 지금 시점 기준가·수수료로 판매 시작
//   · 반려: 초안으로 되돌리고 사유 통지 (리서처가 고쳐서 재제출 가능)
// 게시 중(PUBLISHED) — 승인 후 재검토·구버전 데이터
//   · 게시 유지 / 강제 철회(전액 환불). 되돌릴 수 없어 사유·확인 단계를 거친다

type Mode = "IDLE" | "REJECT" | "TAKEDOWN";

export function ResolveButton({
  reviewId,
  reportId,
  reportStatus,
  heldPurchases,
  heldAmountKrw,
}: {
  /** 검토 큐 항목일 때만 존재 — 판매 중 목록에서 온 건은 없다 */
  reviewId?: string;
  reportId: string;
  reportStatus: string;
  heldPurchases: number;
  heldAmountKrw: number;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("IDLE");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = reportStatus === "PENDING_REVIEW";

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
        setError(payload.issues ? payload.issues.join(" / ") : (payload.error ?? failMessage));
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (mode !== "IDLE") {
    const takedown = mode === "TAKEDOWN";
    return (
      <div className={styles.form}>
        <p className={styles.hint}>
          {takedown ? (
            <>
              게시가 중단되고 예측 카드는 판정 불가(철회)로 확정됩니다.
              {heldPurchases > 0
                ? ` 구매 ${heldPurchases}건 ${heldAmountKrw.toLocaleString()}원이 전액 환불되고, 리서처 정산과 플랫폼 수수료는 발생하지 않습니다.`
                : " 아직 구매 건이 없어 환불 대상은 없습니다."}{" "}
              이 카드는 리서처 점수에 반영되지 않습니다. 되돌릴 수 없습니다.
            </>
          ) : (
            <>
              리포트가 초안으로 돌아가고 사유가 리서처에게 전달됩니다. 아직 판매되지 않았으므로
              환불·정산은 발생하지 않으며, 리서처는 문구를 고쳐 다시 게시할 수 있습니다.
            </>
          )}
        </p>
        <label className={styles.field}>
          <span className={styles.label}>
            {takedown ? "강제 철회 사유" : "반려 사유"} (리서처에게 통지, 필수)
          </span>
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
            onClick={() =>
              post(
                { action: takedown ? "TAKEDOWN" : "REJECT", reportId, reason },
                takedown ? "철회 실패" : "반려 실패",
              )
            }
            disabled={busy || !reason.trim()}
          >
            {busy ? "처리 중…" : takedown ? "강제 철회 실행" : "반려"}
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
      {pending ? (
        <>
          <button
            className={styles.primaryBtn}
            onClick={() => post({ action: "APPROVE", reportId }, "승인 실패")}
            disabled={busy}
          >
            {busy ? "처리 중…" : "게시 승인"}
          </button>
          <button
            className={`${styles.actionBtn} ${styles.danger}`}
            onClick={() => setMode("REJECT")}
            disabled={busy}
          >
            반려
          </button>
        </>
      ) : (
        <>
          {reviewId && (
            <button
              className={styles.primaryBtn}
              onClick={() => post({ action: "RESOLVE", reviewId }, "처리 실패")}
              disabled={busy}
            >
              {busy ? "처리 중…" : "게시 유지"}
            </button>
          )}
          {reportStatus === "PUBLISHED" && (
            <button
              className={`${styles.actionBtn} ${styles.danger}`}
              onClick={() => setMode("TAKEDOWN")}
              disabled={busy}
            >
              강제 철회
            </button>
          )}
        </>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
