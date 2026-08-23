"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../admin.module.css";

// 문의 답변 폼 — 잉크 규칙: **답을 적어야 보낼 수 있고, 그때 버튼이 잉크로 살아난다.**
//
// 답변은 이용자 알림으로 **그대로** 나간다(supportService.answerSubmitTicket이 같은
// 트랜잭션에서 알림을 만든다). 그래서 입력칸의 안내가 "무엇을 쓰나"가 아니라
// "이 글이 어디로 가나"를 말한다 — 쓰는 순간 그것이 최종본이라는 사실이 중요하다.

export function AnswerForm({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = answer.trim().length > 0;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ticketId, answer }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "처리에 실패했습니다");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리에 실패했습니다");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={styles.field}>
        <textarea
          className={styles.textarea}
          rows={2}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="답변 — 이용자 알림으로 그대로 갑니다"
          aria-label="답변"
          maxLength={2000}
        />
      </div>

      {/* 나가기 전에 무엇이 나가는지 — 이 글이 알림 본문 그 자체다 */}
      <div className={styles.sent}>
        <div className={styles.sTag}>이용자 알림함에 이렇게 도착합니다</div>
        <div className={`${styles.sV} ${ready ? "" : styles.sVNone}`}>
          {answer.trim() || "답변을 적으면 여기 그대로 나타납니다"}
        </div>
      </div>

      <div className={styles.btnrow}>
        <button
          type="button"
          className={`${styles.btn} ${ready && !busy ? styles.btnInk : styles.btnLine}`}
          disabled={!ready || busy}
          onClick={submit}
        >
          {busy ? "보내는 중…" : "답변 보내기"}
        </button>
      </div>
      {!ready && <div className={styles.gate}>답변 내용을 적어야 보낼 수 있습니다</div>}
      {error && <p className={styles.error}>{error}</p>}
    </>
  );
}
