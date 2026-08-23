"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import a from "../admin.module.css";

// 신고 검토 폼 — **갈래를 먼저 고르고, 고른 쪽 버튼만 잉크색으로 살아난다**
// (2026-08-19 사용자 확정 — 시안 v3의 규칙을 그대로 옮겼다).
//
// 전에는 사유만 쓰면 확인·기각 버튼이 동시에 켜졌다. 결과가 정반대인 두 버튼이
// 같은 얼굴로 나란히 있으면 **어느 쪽을 누르기로 했는지가 화면에 없다** — 실수 클릭이
// 곧바로 통지·보상으로 이어지는 자리라, 판단을 한 번 고르게 하고 그 선택이 색으로
// 보이게 한다. 잉크 = 지금 누를 수 있는 쪽 (시안의 색 규칙과 같다).

const DECISIONS = {
  CONFIRMED: {
    pick: "위반이 맞다",
    submit: "위반 확인 — 신고자 통지 · 보상 판단",
    placeholder: "예: 리포트 본문에 오픈채팅 유도 문구 확인",
  },
  REJECTED: {
    pick: "위반이 아니다 (오신고)",
    submit: "기각 — 신고자에게 통지",
    placeholder: "예: 인용된 문구가 본문에 없음 / 근거 불충분",
  },
} as const;
type Decision = keyof typeof DECISIONS;

export function ReviewForm({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = decision !== null && note.trim().length > 0;

  const submit = async () => {
    if (!ready || !decision) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/abuse-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reportId, decision, note }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "처리에 실패했습니다");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "처리에 실패했습니다");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={a.field}>
      {/* 갈래 고르기 — 같은 축의 선택이라 서로를 대체한다 */}
      <div className={a.chips}>
        {(Object.keys(DECISIONS) as Decision[]).map((d) => (
          <button
            key={d}
            type="button"
            className={`${a.pick} ${decision === d ? a.pickOn : ""}`}
            onClick={() => setDecision(decision === d ? null : d)}
          >
            {DECISIONS[d].pick}
          </button>
        ))}
      </div>

      <div className={a.field}>
        <input
          className={a.input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            decision ? DECISIONS[decision].placeholder : "먼저 위에서 판단을 골라 주세요"
          }
          aria-label="검토 사유"
          maxLength={2000}
        />
      </div>

      {/* **잉크 = 지금 누를 수 있다.** 갈래와 사유가 다 차기 전에는 회색이고,
          차는 순간 고른 판단의 이름을 달고 잉크로 살아난다 */}
      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${ready && !busy ? a.btnInk : a.btnLine}`}
          disabled={!ready || busy}
          onClick={submit}
        >
          {busy
            ? "처리 중…"
            : decision
              ? DECISIONS[decision].submit
              : "판단과 사유를 채우면 열립니다"}
        </button>
      </div>
      {!ready && <div className={a.gate}>판단을 고르고 사유를 적어야 보낼 수 있습니다</div>}
      {error && <p className={a.error}>{error}</p>}
    </div>
  );
}
