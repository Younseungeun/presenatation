"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import a from "../admin.module.css";

// 명의 불일치의 두 갈래 (시안 v3) — **어느 쪽도 계좌를 열어 주지 않는다.**
// 이름이 맞는지는 은행 조회가 답하는 것이지 운영자가 눈으로 정할 일이 아니다.
//   보류 유지 → 확인했다는 사실만 감사에 남는다
//   확인 요청 → 리서처에게 다시 등록해 달라고 알린다
export function MismatchActions({ researcherUserId }: { researcherUserId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"HOLD" | "ASK" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "HOLD" | "ASK") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/admin/account-mismatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ researcherUserId, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "처리에 실패했습니다");
      setDone(action === "ASK" ? "재등록 요청을 보냈습니다" : "보류 유지로 기록했습니다");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리에 실패했습니다");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${a.btnLine}`}
          onClick={() => act("HOLD")}
          disabled={busy !== null}
        >
          {busy === "HOLD" ? "기록 중…" : "보류 유지"}
        </button>
        <button
          type="button"
          className={`${a.btn} ${busy ? a.btnLine : a.btnInk}`}
          onClick={() => act("ASK")}
          disabled={busy !== null}
        >
          {busy === "ASK" ? "보내는 중…" : "확인 요청"}
        </button>
      </div>
      {done && (
        <p className={a.hint} style={{ color: "var(--pos)", fontWeight: 700 }}>
          {done}
        </p>
      )}
      {error && <p className={a.error}>{error}</p>}
    </>
  );
}
