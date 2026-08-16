"use client";

import { useState } from "react";
import type { PayoutAccountView } from "@/server/payoutAccountView";
import styles from "./payout.module.css";

// **동결 버튼** — 41차에 만든 `freezePayouts`가 처음으로 눌릴 수 있게 되는 자리.
//
// 이 화면이 지켜야 할 것은 기능이 아니라 **속도**다. 계좌가 바뀌었다는 알림을 본
// 사람이 "이거 내가 안 바꿨는데"라고 느끼는 순간부터 버튼을 누르기까지가 짧아야
// 48시간 쿨다운이 골든타임이 된다. 그래서:
//   · 확인 대화상자를 **한 번만** 띄운다 (되돌릴 수 있는 쪽이라 문턱을 낮게)
//   · 사유는 **선택**이다 — 급한 사람에게 글을 쓰게 하면 그만큼 늦어진다
//   · 실패해도 버튼이 남아 있다 — 급한 순간에 눌린 흔적 없이 사라지는 것이 최악이다

export function FreezeButton({ initial }: { initial: PayoutAccountView }) {
  const [view, setView] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function freeze() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/payout/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "동결에 실패했습니다");
      setView(body as PayoutAccountView);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "동결에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (view.frozen) {
    return (
      <div className={styles.frozenBox}>
        <div className={styles.frozenTitle}>정산이 동결되었습니다</div>
        <p className={styles.frozenBody}>
          이 계정에서는 지금 어떤 돈도 나가지 않습니다. 운영자에게 알림이 갔습니다.
        </p>
        <p className={styles.frozenBody}>
          <strong>해제는 운영자만 할 수 있습니다.</strong> 본인 확인을 마쳐야 풀립니다 —
          계정을 쥔 사람이 스스로 풀 수 있으면 이 장치가 아무것도 아니게 되기 때문입니다.
        </p>
      </div>
    );
  }

  if (!confirming) {
    return (
      <>
        <button type="button" className={styles.freezeButton} onClick={() => setConfirming(true)}>
          정산 동결하기
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </>
    );
  }

  return (
    <div className={styles.confirmBox}>
      <div className={styles.confirmTitle}>정산을 동결할까요?</div>
      <p className={styles.confirmBody}>
        지급이 즉시 멈추고 운영자가 확인합니다. 잘못 눌렀다면 운영자에게 연락하면 풀립니다 —
        <strong> 늦게 누르는 것보다 잘못 누르는 편이 낫습니다.</strong>
      </p>
      <label className={styles.reasonLabel}>
        무슨 일이 있었나요? <span className={styles.optional}>(선택)</span>
        <textarea
          className={styles.reason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder="예: 계좌 변경 알림을 받았는데 제가 바꾸지 않았습니다"
        />
      </label>
      <div className={styles.confirmActions}>
        <button
          type="button"
          className={styles.freezeButton}
          onClick={freeze}
          disabled={busy}
        >
          {busy ? "동결하는 중…" : "네, 동결합니다"}
        </button>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          취소
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
