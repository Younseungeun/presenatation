"use client";

import { useState } from "react";
import a from "../admin.module.css";

// **2차를 사람이 나른다** (2026-08-21 사용자 확정 · 18차 검토 반영).
//
// AI 검수기가 연결돼 있지 않으면 2차가 통째로 건너뛰어지고, 1차 소견이 있는 건은
// 그대로 여기 쌓인다. 그때 운영자가 할 일은 교사에게 직접 물어보는 것인데,
// 물어볼 재료를 손으로 조립하면 **매번 다른 기준의 답**이 나온다. 조립을 서버가 하고,
// 화면은 나르는 일과 **순서를 지키게 하는 일**만 한다.
//
// ── 화면이 맡은 방어 하나: 새 대화 (18차 V-6) ────────────────────────
// 자동 2차는 매 건이 독립 요청이라 맥락 이월이 원리적으로 없었다. 사람이 나르면 한
// 창에서 연속으로 묻게 되고 앞 건의 판정이 뒤 건을 민다. 코드가 강제할 수 없는 자리라
// 세 겹으로 나눠 막는다:
//   ① 질문지 맨 위의 맥락 폐기 문구      (teacherPack.contextReset)
//   ② 이 체크박스 — 심리적 마찰          (여기)
//   ③ 답의 id 대조 — 앞 건 답 복사 차단  (domain/teacherAnswer.parseTeacherAnswer)
// 어느 하나도 혼자서는 못 막는다.
export function AskTeacher({ reviewId, decided }: { reviewId: string; decided: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "fail">("idle");
  const [error, setError] = useState<string | null>(null);
  const [freshChat, setFreshChat] = useState(false);

  async function copy() {
    setState("busy");
    setError(null);
    try {
      const res = await fetch(`/api/admin/compliance/ask?reviewId=${encodeURIComponent(reviewId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "질문지를 만들지 못했습니다");
      await navigator.clipboard.writeText(json.text);
      setState("done");
      // 되돌아오는 이유: 한 건을 두 번 물어볼 수 있어야 한다(답이 애매했을 때).
      // "복사됨"이 남아 있으면 버튼이 죽은 것처럼 보인다
      setTimeout(() => setState("idle"), 4000);
    } catch (e) {
      setState("fail");
      setError(
        e instanceof Error && e.message.includes("clipboard")
          ? "클립보드 접근이 막혀 있습니다 — 주소창이 https인지 확인해 주세요"
          : e instanceof Error
            ? e.message
            : "질문지를 만들지 못했습니다",
      );
    }
  }

  return (
    <>
      <label className={a.check}>
        <input
          type="checkbox"
          checked={freshChat}
          onChange={(e) => setFreshChat(e.target.checked)}
        />
        <span>
          <b>새 대화창을 열었습니다</b> — 앞 건과 같은 창에서 물으면 앞의 판정이 이 건의
          답을 밉니다. 자동 검수는 매번 새 요청이었습니다.
        </span>
      </label>

      <button
        type="button"
        className={`${a.btn} ${a.btnLine}`}
        onClick={copy}
        disabled={state === "busy" || !freshChat}
        style={{ marginTop: 8 }}
      >
        {state === "busy"
          ? "만드는 중…"
          : state === "done"
            ? "복사됨 — 붙여 넣으세요"
            : "교사에게 물어볼 질문지 복사"}
      </button>

      {/* **순서를 화면이 말한다** (18차 V-3). 서버도 막지만(recordTeacherAnswer),
          거절만 하면 운영자는 왜 막혔는지 모른 채 답을 잃는다 */}
      {!decided && (
        <p className={a.hint} style={{ marginTop: 8 }}>
          답을 받으면 <b>먼저 승인·반려를 결정</b>한 뒤 기록합니다. 답을 보고 고르면 두
          판단이 같은 출처가 되어, 교사가 정확한 것인지 확인을 건너뛴 것인지 나중에
          가릴 수 없습니다.
        </p>
      )}

      {error && <p className={a.error}>{error}</p>}
    </>
  );
}
