"use client";

import { useState } from "react";
import styles from "./approvals.module.css";

type Approval = {
  id: string;
  action: string;
  summary: string;
  amountKrw: number | null;
  requestedBy: string;
  requestedAt: string;
  reason: string;
};

// 승인 대기열 — **승인자가 무엇을 승인하는지 알아야 승인이 의미를 갖는다.**
//
// 요약·사유·금액·요청자를 다 보여준다. "승인" 버튼만 있는 화면은 누르는 습관을
// 만들고, 습관이 된 승인은 2인 승인이 아니라 클릭 두 번일 뿐이다.

const ACTION_LABEL: Record<string, string> = {
  PAYOUT_UNFREEZE: "정산 동결 해제",
  LARGE_PAYOUT: "고액 지급 실행",
  DISPUTE_UPHOLD: "판정 이의 인정 (판정 뒤집기)",
};

export function ApprovalList({ initial }: { initial: Approval[] }) {
  const [items, setItems] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: id, approve }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "처리에 실패했습니다");
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리에 실패했습니다");
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return <p className={styles.empty}>대기 중인 승인 요청이 없습니다.</p>;
  }

  return (
    <>
      {error && <p className={styles.error}>{error}</p>}
      {items.map((a) => (
        <div key={a.id} className={styles.card}>
          <div className={styles.action}>{ACTION_LABEL[a.action] ?? a.action}</div>
          <div className={styles.summary}>{a.summary}</div>
          {a.amountKrw != null && (
            <div className={styles.amount}>{a.amountKrw.toLocaleString()}원</div>
          )}
          <div className={styles.meta}>
            요청 {new Date(a.requestedAt).toLocaleString("ko-KR")} · {a.requestedBy}
          </div>
          <div className={styles.reason}>{a.reason}</div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.approve}
              onClick={() => decide(a.id, true)}
              disabled={busy === a.id}
            >
              승인
            </button>
            <button
              type="button"
              className={styles.reject}
              onClick={() => decide(a.id, false)}
              disabled={busy === a.id}
            >
              반려
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
