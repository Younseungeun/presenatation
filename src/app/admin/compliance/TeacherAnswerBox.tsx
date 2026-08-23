"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import a from "../admin.module.css";

// **받은 답을 기록한다 — 운영자가 결정한 뒤에** (18차 V-3).
//
// ── 이 화면이 하는 일이 곧 라벨의 품질이다 ───────────────────────────
// 교사 답은 학습 라벨의 절반이고, 나머지 절반은 운영자의 결정이다. 두 값이 **따로**
// 저장돼야 불일치율이 교사 품질의 지표가 된다 — 운영자가 교사 답을 보고 고치면
// 두 값이 같은 출처가 되어 지표가 자기 자신을 재게 된다.
//
// 그래서 이 상자는 **결정이 끝난 건에만** 나타난다. 서버도 같은 것을 막지만
// (recordTeacherAnswer), 막기만 하면 운영자는 답을 잃고 이유를 모른다.
//
// ── 교사 표식을 매번 확인시키는 이유 (18차 V-4) ──────────────────────
// 대화창의 교사는 버전이 오른다. 표식이 없으면 나중에 "이 라벨은 어느 교사가
// 만들었나"를 영원히 못 가르고, 교사가 바뀐 전후의 라벨을 섞어 재학습하게 된다.
// **매 건 적게 하지는 않는다** — 적게 하면 틀린다. 하루 한 번만 확인시킨다.

export function TeacherAnswerBox({
  reviewId,
  teacherTag,
  stale,
}: {
  reviewId: string;
  teacherTag: string | null;
  stale: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [tag, setTag] = useState(teacherTag ?? "");
  // 표식이 오늘 확인된 값이면 접어 둔다 — 매번 펴 두면 확인이 습관이 되어 안 읽힌다
  const [confirming, setConfirming] = useState(stale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ disagreed: boolean; labels: string[] } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId, text, teacherTag: tag.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "답을 기록하지 못했습니다");
      setResult({ disagreed: json.disagreed, labels: json.answer?.labels ?? [] });
      setText("");
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "답을 기록하지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className={`${a.note} ${result.disagreed ? a.noteNeg : ""}`}>
        <b>기록했습니다.</b>{" "}
        {result.labels.length > 0 ? `교사 판정: ${result.labels.join(", ")}` : "교사 판정: 위반 없음"}
        {result.disagreed && (
          <>
            {" — "}
            <b>운영자 결정과 갈렸습니다.</b> 이 건은 다음 질문지의 교정 사례로 들어갑니다.
          </>
        )}
      </div>
    );
  }

  return (
    <div className={a.field} style={{ marginTop: 10 }}>
      {confirming ? (
        <>
          <label className={a.lbl}>지금 쓰는 교사</label>
          <input
            className={a.input}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="예: claude-opus-5 (대화창)"
          />
          <p className={a.hint}>
            {teacherTag
              ? "오늘 처음 기록합니다. 교사가 그대로면 그대로 두고 넘어가세요."
              : "이 값이 학습 라벨에 함께 박힙니다. 교사가 바뀌면 여기서 고쳐 주세요."}
          </p>
        </>
      ) : (
        <p className={a.hint}>
          교사: <b>{tag || "(미지정)"}</b>{" "}
          <button type="button" className={a.linkBtn} onClick={() => setConfirming(true)}>
            바꾸기
          </button>
        </p>
      )}

      <label className={a.lbl} style={{ marginTop: 8 }}>
        교사가 준 답
      </label>
      <textarea
        className={a.textarea}
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'{"id":"review:...","labels":[]}\n지적: 과함'}
      />
      <p className={a.hint}>
        받은 답을 <b>그대로</b> 붙여 넣으세요. 요약하거나 옮겨 적으면 거기서 라벨이
        흐려집니다. 형식이 어긋나면 기록하지 않고 그대로 알려 드립니다 —{" "}
        <b>못 읽은 답을 지어내지 않습니다.</b>
      </p>

      <button
        type="button"
        className={a.btn}
        onClick={submit}
        disabled={busy || !text.trim() || !tag.trim()}
      >
        {busy ? "기록 중…" : "교사 답 기록"}
      </button>
      {error && <p className={a.error}>{error}</p>}
    </div>
  );
}
