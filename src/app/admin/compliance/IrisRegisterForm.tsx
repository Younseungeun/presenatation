"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RiskCategory } from "@/domain/compliance";
import a from "../admin.module.css";

// 졸업 강등 본선의 실행 통로 (Q1, 2026-09-01 창업자 확정) — IRIS 유형별 모음의 각 유형에서
// 학습 표현을 바로 등록한다. 출처(그 유형의 최근 확정 IRIS 건)는 서버가 물리므로 화면은
// 표현만 받는다 — 출처 없는 등록은 서버가 거부한다.
//
// 접어 둔다: 등록은 IRIS→사전 관할을 옮기는 결정이라 훑다가 눌러지는 자리에 있으면 안 된다.

export function IrisRegisterForm({ category }: { category: RiskCategory }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance/register-from-iris", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, phrase: phrase.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "등록하지 못했습니다");
        return;
      }
      setDone(true);
      setPhrase("");
      router.refresh();
    } catch {
      setError("서버에 닿지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={a.chip} onClick={() => setOpen(true)} style={{ marginTop: 6 }}>
        학습 표현 등록 ▾
      </button>
    );
  }

  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6, maxWidth: 360 }}>
      <p className={a.hint} style={{ margin: 0 }}>
        이 유형에서 IRIS만 잡던 표현을 사전에 내립니다. 출처(근거가 된 확정 건)는 자동으로 물립니다.
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input
          className={a.textarea}
          style={{ flex: "1 1 200px", minHeight: 0, padding: "8px 10px" }}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder='재사용 가능한 짧은 꼴로 (예: "노란 앱")'
          aria-label="등록할 표현"
        />
        <button type="button" className={a.btn} style={{ flex: "0 0 auto" }} onClick={submit} disabled={busy || !phrase.trim()}>
          {busy ? "등록 중…" : "등록"}
        </button>
      </div>
      {error && <p className={a.error} style={{ margin: 0 }}>{error}</p>}
      {done && <p className={a.hint} style={{ margin: 0, color: "#0e6f5c" }}>등록됐습니다 — 이제 작성 화면과 게시 검수가 이 표현을 잡습니다.</p>}
    </div>
  );
}
