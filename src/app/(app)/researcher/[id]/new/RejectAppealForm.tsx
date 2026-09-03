"use client";

import { useState } from "react";
import { APPEAL_MIN_STATEMENT } from "@/domain/rejectAppeal";

// 거절 이의 (B1, 2026-09-01) — 즉시 거절을 받은 그 자리에서 "이 인용문은 위반이 아닙니다"를 소명한다.
// "억울하다"는 낼 수 없고 **어떤 문맥이었는지**를 적어야 접수된다(판정 이의가 "맞다고 보는
// 가격"을 요구하는 것과 같은 구조). 상한(거절 1건 1회 · 미결 2건 · 반려 누적 3회면 닫힘)은
// 서버가 최종 관문이다 — 여기 글자 수는 미리 알려 주는 것뿐.

export function RejectAppealForm({ reportId }: { reportId: string }) {
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = statement.trim().length < APPEAL_MIN_STATEMENT;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/compliance/reject-appeal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, statement: statement.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "이의를 내지 못했습니다");
        return;
      }
      setDone(true);
    } catch {
      setError("서버에 닿지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p style={{ marginTop: 8, fontSize: 13, color: "var(--text-weak)" }}>
        이의가 접수됐습니다. 운영자가 확인하면 알림으로 알려 드립니다 — 검수 오류로 확인되면 본문을
        고치지 않고 그대로 다시 제출하시면 됩니다.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          font: "inherit",
          fontSize: 13,
          padding: "6px 10px",
          borderRadius: 99,
          border: "1px solid var(--line)",
          background: "transparent",
          color: "var(--text-weak)",
          cursor: "pointer",
        }}
      >
        {open ? "이의 접기 ▴" : "이 표현은 위반이 아닙니다 — 이의 제기 ▾"}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-weak)" }}>
            걸린 인용문이 <b>어떤 문맥</b>이었는지 적어 주세요 ({APPEAL_MIN_STATEMENT}자 이상). 예:
            &ldquo;면책 문구로 &lsquo;보장하지 않는다&rsquo;고 쓴 것입니다&rdquo;. 거절 1건에 이의는 1회,
            운영자가 확인하면 알림이 갑니다.
          </p>
          <textarea
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            rows={3}
            aria-label="이의 소명"
            style={{
              font: "inherit",
              fontSize: 14,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--line)",
              resize: "vertical",
            }}
          />
          {error && <p style={{ margin: 0, fontSize: 13, color: "var(--neg)" }}>{error}</p>}
          <div>
            <button
              type="button"
              onClick={submit}
              disabled={busy || short}
              style={{
                font: "inherit",
                fontSize: 14,
                fontWeight: 700,
                padding: "10px 14px",
                borderRadius: 12,
                border: "none",
                background: busy || short ? "#e9ecef" : "var(--text)",
                color: busy || short ? "#5f6b77" : "#fff",
                cursor: busy || short ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "접수 중…" : short ? `${APPEAL_MIN_STATEMENT - statement.trim().length}자 더 적어 주세요` : "이의 접수"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
