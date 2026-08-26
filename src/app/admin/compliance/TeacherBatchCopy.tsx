"use client";

import { useState } from "react";
import a from "../admin.module.css";

// **답을 안 걷은 질문지를 모두 이어 붙여 한 번에 복사한다** (2026-08-27 창업자 지시).
// 판정을 여러 건 쌓아 놓고 일괄로 교사에게 물어보는 흐름의 마지막 조각.
// 각 질문지는 맨 위 맥락 폐기 문구로 격리되고, 사이에 "여기서부터 새 대화창" 구분선이
// 들어가 어디서 끊을지 눈에 보인다.
export function TeacherBatchCopy() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "fail">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function copyAll() {
    setState("busy");
    setMsg(null);
    try {
      const res = await fetch("/api/admin/compliance/ask?all=1");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "가져오지 못했습니다");
      await navigator.clipboard.writeText(json.text);
      setState("done");
      setMsg(`${json.count}건 복사됨`);
      setTimeout(() => setState("idle"), 4000);
    } catch (e) {
      setState("fail");
      setMsg(
        e instanceof Error && e.message.includes("clipboard")
          ? "클립보드 접근이 막혀 있습니다 — 주소창이 https인지 확인해 주세요"
          : e instanceof Error
            ? e.message
            : "가져오지 못했습니다",
      );
    }
  }

  return (
    <>
      <button
        type="button"
        className={`${a.btn} ${a.btnLine}`}
        onClick={copyAll}
        disabled={state === "busy"}
      >
        {state === "busy" ? "만드는 중…" : state === "done" ? (msg ?? "복사됨") : "일괄 복사"}
      </button>
      {state === "fail" && msg && <p className={a.error}>{msg}</p>}
    </>
  );
}
