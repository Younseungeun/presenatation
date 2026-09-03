"use client";

import { useState } from "react";
import a from "../admin.module.css";

// **2차를 사람이 나른다** (2026-08-21 사용자 확정 · 18차 검토 반영).
//
// AI 검수기가 연결돼 있지 않으면 2차가 통째로 건너뛰어지고, 1차 소견이 있는 건은
// 그대로 여기 쌓인다. 그때 운영자가 할 일은 교사에게 직접 물어보는 것인데,
// 물어볼 재료를 손으로 조립하면 **매번 다른 기준의 답**이 나온다. 조립을 서버가 하고,
// 화면은 나르는 일만 한다.
//
// ── 맥락 이월 방어는 둘로 남긴다 (2026-08-26 창업자 확정: 체크박스 제거) ──
// 자동 2차는 매 건이 독립 요청이라 맥락 이월이 원리적으로 없었다. 사람이 나르면 한
// 창에서 연속으로 묻게 되고 앞 건의 판정이 뒤 건을 민다. 코드가 강제할 수 없는 자리라
// 나눠 막는다:
//   ① 질문지 맨 위의 맥락 폐기 문구      (teacherPack.contextReset)
//   ② 답의 id 대조 — 앞 건 답 복사 차단  (domain/teacherAnswer.parseTeacherAnswer)
// 체크박스(심리적 마찰)는 걷어냈다 — 문구와 id 대조가 이미 있어 마찰만 늘렸고,
// 매번 눌러야 복사가 되니 정작 급할 때 방해가 됐다.
export function AskTeacher({ reviewId, decided }: { reviewId: string; decided: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "fail">("idle");
  const [error, setError] = useState<string | null>(null);

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
      {/* **판정을 먼저 기록해야 열린다** (2026-08-26 창업자 확정 — 목적 재정의).
          이 자료는 "사람은 이렇게, 자동 검수는 이렇게 판단했다"를 나란히 놓는 것이라
          사람 판정이 없으면 비교의 절반이 빈다. 그래서 decided 전에는 잠근다 */}
      <button
        type="button"
        className={`${a.btn} ${a.btnLine}`}
        onClick={copy}
        disabled={state === "busy" || !decided}
      >
        {state === "busy"
          ? "만드는 중…"
          : state === "done"
            ? "복사됨 — 붙여 넣으세요"
            : "재학습 논의 자료 복사 (사람 vs 자동 검수)"}
      </button>

      {!decided ? (
        <p className={a.hint} style={{ marginTop: 8 }}>
          먼저 위에서 <b>승인·반려를 결정</b>하면 열립니다. 이 자료는 판정을 요청하는 것이
          아니라 <b>사람 판정과 자동 검수(RULE+ARGOS) 판정을 나란히 놓고</b> ARGOS 재학습·학습
          표현 등록을 논의하기 위한 것이라, 사람 판정이 먼저 있어야 합니다.
        </p>
      ) : (
        <>
          {/* **새 대화창 안내** — 강제(체크박스)는 걷었지만 안내는 남긴다. 질문지 맨 위의
              맥락 문구가 실제 방어이고, 이 줄은 운영자가 그 이유를 알게 하는 용도다.
              쌓인 기준(규정·교정 사례)은 질문지가 늘 싣는다 — 여기서 막는 것은 앞 건의
              결론이 이 건에 스미는 것뿐이다 (2026-08-26) */}
          <p className={a.hint} style={{ marginTop: 8 }}>
            <b>매 건 새 대화창에서 논의해 주세요.</b> 규정과 과거 교정 사례는 자료에 늘
            들어가니 기준은 그대로 이어집니다. 다만 같은 창에서 연속으로 다루면 <b>앞 건의
            결론</b>이 이 건에 스밉니다 — 그것만 새 창이 끊어 줍니다.
          </p>
        </>
      )}

      {error && <p className={a.error}>{error}</p>}
    </>
  );
}
